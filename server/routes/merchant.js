const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const db = require('../db');
const { requireUser, flash, takeFlash } = require('../services/session');
const { messageFor } = require('../services/messages');
const { normaliseCode } = require('../services/trade-identity');

/**
 * Kora Merchant badge, paid with PayV.
 *
 * Merchants trade in volume, so Kora wants a fresh look at their INFRA
 * verification. Instead of a subscription, the merchant pays a small fee in
 * USDC (on Base) from their own wallet each time Kora reuses it:
 *
 *   1. They share their verification with Kora using an INFRA Connect code,
 *      billed per verification (billing: 'payv'). That is the consent.
 *   2. They connect a wallet. Kora asks PayV for a price FOR THAT WALLET
 *      (payer_address). If Kora requires the merchant's own wallet and this
 *      one isn't linked, INFRA says so now (409), before anything is signed;
 *      they link it (sign a message + approve in INFRA) and Kora asks again.
 *   3. Their wallet signs a USDC transfer authorization in the browser
 *      (client/public/payv.js). The quote only accepts that wallet.
 *   4. Kora sends it with the X-PAYMENT header and gets the verification.
 *      INFRA takes the money only after the data is ready.
 */
const SCOPES = ['profile:basic', 'kyc:status'];
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

module.exports = function merchantRoutes({ infra }) {
  const router = express.Router();
  const configured = () => Boolean(config.payv.clientId && config.payv.clientSecret);

  router.get('/merchant', requireUser, (req, res) => {
    res.render('merchant', {
      title: 'Merchant badge',
      user: req.user,
      configured: configured(),
      checks: db.listMerchantChecks(req.user.id),
      flash: takeFlash(req),
    });
  });

  // Step 1: the Connect code records consent for the PayV app. For PayV
  // apps, Connect returns no data, only who consented.
  router.post('/merchant/start', requireUser, async (req, res) => {
    if (!configured()) {
      flash(req, 'error', 'The merchant badge is not set up on this Kora yet (PAYV_CLIENT_ID is missing).');
      return res.redirect('/merchant');
    }
    const code = normaliseCode(req.body.code);
    if (!code) {
      flash(req, 'error', "That doesn't look like an INFRA Connect code. It looks like CNX-AB12-CD34.");
      return res.redirect('/merchant');
    }
    try {
      const consent = await infra.redeemConnectCode({ code, scopes: SCOPES, app: 'payv', billing: 'payv' });
      if (!consent.ok || !consent.data?.user_id) {
        flash(req, 'error', messageFor(consent, "INFRA couldn't check that code. Make a new one and try again."));
        return res.redirect('/merchant');
      }
      const id = db.startMerchantCheck({ ownerId: req.user.id, infraUserId: consent.data.user_id });
      res.redirect(`/merchant/pay/${id}`);
    } catch (err) {
      flash(req, 'error', messageFor(err));
      res.redirect('/merchant');
    }
  });

  function loadCheck(req, res) {
    const check = db.getMerchantCheckById(Number(req.params.id));
    if (!check || check.owner_id !== req.user.id) {
      if (req.method === 'GET' && !(req.get('accept') || '').includes('application/json')) {
        res.status(404).render('error', { title: 'Payment not found', message: 'This payment request is not yours or no longer exists.', user: req.user });
      } else {
        res.status(404).json({ ok: false, message: 'This payment request is not yours or no longer exists.' });
      }
      return null;
    }
    return check;
  }

  router.get('/merchant/pay/:id', requireUser, (req, res) => {
    const check = loadCheck(req, res);
    if (!check) return;
    res.render('merchant-pay', { title: 'Pay with your wallet', user: req.user, check, flash: takeFlash(req) });
  });

  // Step 2: price for this wallet. Asked again after a wallet is linked.
  router.post('/merchant/pay/:id/quote', requireUser, async (req, res) => {
    const check = loadCheck(req, res);
    if (!check) return;
    if (check.status === 'paid') return res.json({ ok: true, paid: true, redirect: '/merchant' });
    const address = String(req.body.address || '');
    if (!ADDRESS_RE.test(address)) return res.status(400).json({ ok: false, message: 'Connect your wallet first.' });

    try {
      const quote = await infra.payvVerification({
        infraUserId: check.infra_user_id,
        scopes: SCOPES,
        payerAddress: address,
        idempotencyKey: crypto.randomUUID(),
      });
      const b = quote.body || {};

      if (quote.status === 402 && b.payment_request_id && (b.accepts || [])[0]) {
        db.setMerchantQuote(check.id, {
          paymentRequestId: b.payment_request_id,
          payerAddress: (b.payer_address || address).toLowerCase(),
          amountDisplay: b.amount_display || null,
          assetSymbol: b.asset_symbol || 'USDC',
          requirementsJson: JSON.stringify(b.accepts[0]),
          payerRequirement: b.payer_requirement || 'any',
        });
        return res.json({
          ok: true,
          requirements: b.accepts[0],
          amount_display: b.amount_display,
          asset_symbol: b.asset_symbol || 'USDC',
          payer_requirement: b.payer_requirement || 'any',
        });
      }

      if (quote.code === 'PAYER_NOT_LINKED' && b.payment_request_id) {
        // No price yet. Keep the request id: wallet linking runs against it.
        db.setMerchantQuote(check.id, {
          paymentRequestId: b.payment_request_id,
          payerAddress: address.toLowerCase(),
          amountDisplay: null,
          assetSymbol: null,
          requirementsJson: null,
          payerRequirement: 'linked_wallet',
        });
      }
      res.status(quote.code === 'PAYER_NOT_LINKED' ? 409 : 400).json({
        ok: false,
        code: quote.code,
        message: messageFor(quote, "INFRA couldn't price this verification. Please try again."),
      });
    } catch (err) {
      res.status(503).json({ ok: false, message: messageFor(err) });
    }
  });

  // Steps 3–4: the browser signed; send the payment to INFRA.
  router.post('/merchant/pay/:id', requireUser, async (req, res) => {
    const check = loadCheck(req, res);
    if (!check) return;
    if (check.status === 'paid') return res.json({ ok: true, redirect: '/merchant' });
    if (!check.payment_request_id || !check.requirements) {
      return res.status(409).json({ ok: false, message: 'Connect your wallet to get a price first.' });
    }

    const xPayment = String(req.body.x_payment || '');
    if (!xPayment || xPayment.length > 8000) {
      return res.status(400).json({ ok: false, message: 'The wallet did not return a payment signature. Try again.' });
    }

    try {
      const result = await infra.payvVerification({
        infraUserId: check.infra_user_id,
        scopes: SCOPES,
        paymentRequestId: check.payment_request_id,
        xPayment,
      });
      if (!result.ok) {
        db.failMerchantCheck(check.payment_request_id, result.code);
        return res.status(result.status === 402 ? 402 : 400).json({
          ok: false,
          code: result.code,
          message: messageFor(result, 'The payment did not go through. Nothing was charged.'),
        });
      }

      const profile = result.data?.profile || {};
      const kyc = result.data?.kyc || {};
      db.completeMerchantCheck(check.payment_request_id, {
        txHash: result.data?.tx_hash || null,
        firstName: profile.first_name || null,
        lastName: profile.last_name || null,
        country: profile.country || null,
        kycLevel: kyc.kyc_level || null,
        verifiedAt: kyc.verified_at || null,
      });
      flash(req, 'ok', 'Paid. Your merchant badge is now on your offers.');
      res.json({ ok: true, redirect: '/merchant' });
    } catch (err) {
      res.status(503).json({ ok: false, message: messageFor(err) });
    }
  });

  // Link the connected wallet to the merchant's INFRA account. Runs against
  // the payment request INFRA returned with PAYER_NOT_LINKED.
  router.post('/merchant/pay/:id/wallet-link', requireUser, async (req, res) => {
    const check = loadCheck(req, res);
    if (!check) return;
    const address = String(req.body.address || '');
    if (!ADDRESS_RE.test(address)) return res.status(400).json({ ok: false, message: 'Connect your wallet first.' });
    if (!check.payment_request_id) return res.status(409).json({ ok: false, message: 'Connect your wallet to get a price first.' });
    try {
      const r = await infra.startWalletLink({ paymentRequestId: check.payment_request_id, address });
      if (!r.ok) return res.status(400).json({ ok: false, message: messageFor(r, "INFRA couldn't start linking this wallet.") });
      res.json({ ok: true, challenge_id: r.data.challenge_id, message: r.data.message });
    } catch (err) {
      res.status(503).json({ ok: false, message: messageFor(err) });
    }
  });

  router.post('/merchant/pay/:id/wallet-link/:challengeId/signature', requireUser, async (req, res) => {
    const check = loadCheck(req, res);
    if (!check) return;
    try {
      const r = await infra.signWalletLink({
        challengeId: req.params.challengeId,
        paymentRequestId: check.payment_request_id,
        signature: String(req.body.signature || ''),
      });
      if (!r.ok) return res.status(400).json({ ok: false, message: messageFor(r, "INFRA didn't accept that signature.") });
      res.json({ ok: true, status: r.data?.status || 'pending' });
    } catch (err) {
      res.status(503).json({ ok: false, message: messageFor(err) });
    }
  });

  router.get('/merchant/pay/:id/wallet-link/:challengeId', requireUser, async (req, res) => {
    const check = loadCheck(req, res);
    if (!check) return;
    try {
      const r = await infra.walletLinkStatus({ challengeId: req.params.challengeId, paymentRequestId: check.payment_request_id });
      if (!r.ok) return res.status(400).json({ ok: false, message: messageFor(r, "INFRA couldn't check the wallet link.") });
      res.json({ ok: true, status: r.data?.status || 'pending' });
    } catch (err) {
      res.status(503).json({ ok: false, message: messageFor(err) });
    }
  });

  return router;
};
