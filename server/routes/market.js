const express = require('express');
const db = require('../db');
const { tierFor, nextStep, syncFromInfra, CLAIM_LABELS } = require('../services/identity');
const { requireUser, accessToken, flash, takeFlash } = require('../services/session');
const { messageFor } = require('../services/messages');
const { normaliseCode, redeemOwnCode, sampleIdentity } = require('../services/trade-identity');

const RESYNC_AFTER_MS = 5 * 60 * 1000;
const ngn = (n) => '₦' + Math.round(n).toLocaleString('en-NG');

/**
 * Who buys and who sells in a trade. Offers say what the poster (maker) does
 * with USDC; the taker does the opposite. The buyer sends naira first, then
 * the seller releases USDC.
 */
function roles(trade) {
  const takerBuys = trade.side === 'buy';
  return {
    buyerId: takerBuys ? trade.taker_id : trade.maker_id,   // maker_id is null for demo traders
    sellerId: takerBuys ? trade.maker_id : trade.taker_id,
  };
}

/**
 * Both sides' verified identities on a trade, from each one's point of view.
 * A demo trader shows a sample identity (they can't make Connect codes).
 */
function identities(trade, me) {
  const pick = (p) => (trade[`${p}_v_first_name`] || trade[`${p}_v_kyc_status`]
    ? {
      first_name: trade[`${p}_v_first_name`], last_name: trade[`${p}_v_last_name`], kyc_status: trade[`${p}_v_kyc_status`],
      kyc_level: trade[`${p}_v_kyc_level`], country: trade[`${p}_v_country`], signed: Boolean(trade[`${p}_v_signed`]),
    }
    : null);
  const taker = pick('taker');
  const maker = trade.maker_id ? pick('maker') : sampleIdentity(trade.demo_name);
  const iAmTaker = trade.taker_id === me;
  const mine = iAmTaker ? taker : maker;
  const theirs = iAmTaker ? maker : taker;
  const ok = (v) => Boolean(v && v.kyc_status === 'verified');
  return { mine, theirs, bothShared: ok(taker) && ok(maker) };
}

function displayName(first, last) {
  return [first, last && `${last[0]}.`].filter(Boolean).join(' ') || 'Kora trader';
}

module.exports = function marketRoutes({ infra }) {
  const router = express.Router();

  /** Keep the trader's INFRA facts fresh without making every page wait. */
  async function refreshIfStale(req) {
    const synced = req.user.synced_at ? Date.parse(req.user.synced_at + 'Z') : 0;
    if (Date.now() - synced < RESYNC_AFTER_MS) return;
    try {
      const token = await accessToken(req, infra);
      if (!token) return;
      db.saveUser(await syncFromInfra(infra, token, req.user.id));
      req.user = db.getUser(req.user.id);
    } catch {
      // Stale data is fine for a page view; webhooks keep the important bits current.
    }
  }

  router.get('/market', requireUser, async (req, res) => {
    await refreshIfStale(req);
    const offers = db.listOffers().map((o) => ({
      ...o,
      name: o.user_id ? displayName(o.first_name, o.last_name) : o.demo_name,
      mine: o.user_id === req.user.id,
      verified: o.user_id ? o.kyc_status === 'verified' : true,
      totalNgn: o.amount_usdc * o.rate_ngn,
    }));
    res.render('market', {
      title: 'Market',
      user: req.user,
      tier: tierFor(req.user),
      next: nextStep(req.user),
      sells: offers.filter((o) => o.side === 'sell'),
      buys: offers.filter((o) => o.side === 'buy'),
      trades: db.listTradesFor(req.user.id),
      flash: takeFlash(req),
      ngn,
    });
  });

  // Polled by the market page so a webhook (say, kyc_verified) shows up without a reload.
  router.get('/status.json', requireUser, (req, res) => {
    const tier = tierFor(req.user);
    const last = (req.user.alerts || [])[0];
    res.json({ kyc_status: req.user.kyc_status, tier: tier.id, claims: req.user.claims.length, last_alert: last ? last.at : null });
  });

  router.post('/refresh', requireUser, async (req, res) => {
    try {
      const token = await accessToken(req, infra);
      if (!token) {
        flash(req, 'error', 'Your INFRA sign-in has expired. Sign in again to refresh your details.');
        return res.redirect('/account');
      }
      db.saveUser(await syncFromInfra(infra, token, req.user.id));
      flash(req, 'ok', 'Your details are up to date with INFRA.');
    } catch (err) {
      flash(req, 'error', messageFor(err));
    }
    res.redirect(req.get('referer')?.endsWith('/market') ? '/market' : '/account');
  });

  router.post('/offers', requireUser, (req, res) => {
    const tier = tierFor(req.user);
    const side = req.body.side === 'buy' ? 'buy' : 'sell';
    const amountUsdc = Number(req.body.amount_usdc);
    const rateNgn = Number(req.body.rate_ngn);

    if (tier.limitNgn === 0) {
      flash(req, 'error', 'Verify your identity with INFRA before posting offers.');
    } else if (!(amountUsdc >= 10 && amountUsdc <= 100_000) || !(rateNgn >= 500 && rateNgn <= 5000)) {
      flash(req, 'error', 'Enter an amount between 10 and 100,000 USDC and a rate between ₦500 and ₦5,000.');
    } else if (amountUsdc * rateNgn > tier.limitNgn) {
      flash(req, 'error', `That offer is worth ${ngn(amountUsdc * rateNgn)}. Your limit is ${ngn(tier.limitNgn)} per trade.`);
    } else {
      db.createOffer({ userId: req.user.id, side, amountUsdc, rateNgn });
      flash(req, 'ok', 'Your offer is live.');
    }
    res.redirect('/market');
  });

  router.post('/offers/:id/close', requireUser, (req, res) => {
    if (db.closeOffer(Number(req.params.id), req.user.id)) flash(req, 'ok', 'Offer closed.');
    res.redirect('/market');
  });

  router.get('/offers/:id', requireUser, (req, res, next) => {
    const offer = db.getOffer(Number(req.params.id));
    if (!offer || !offer.active) return next();
    res.render('offer', {
      title: 'Offer',
      user: req.user,
      tier: tierFor(req.user),
      next: nextStep(req.user),
      offer: { ...offer, name: offer.user_id ? displayName(offer.first_name, offer.last_name) : offer.demo_name },
      mine: offer.user_id === req.user.id,
      flash: takeFlash(req),
      ngn,
    });
  });

  router.post('/offers/:id/trade', requireUser, (req, res) => {
    const offer = db.getOffer(Number(req.params.id));
    const back = `/offers/${req.params.id}`;
    if (!offer || !offer.active) {
      flash(req, 'error', 'That offer is no longer available.');
      return res.redirect('/market');
    }
    const tier = tierFor(req.user);
    const amountUsdc = Number(req.body.amount_usdc);
    const total = amountUsdc * offer.rate_ngn;

    let problem = null;
    if (offer.user_id === req.user.id) problem = "You can't trade with your own offer.";
    else if (tier.limitNgn === 0) problem = 'Verify your identity with INFRA before trading.';
    else if (!(amountUsdc >= 1) || amountUsdc > offer.amount_usdc) problem = `Enter an amount between 1 and ${offer.amount_usdc} USDC.`;
    else if (total > tier.limitNgn) problem = `That trade is worth ${ngn(total)}. Your limit is ${ngn(tier.limitNgn)} per trade.`;
    if (problem) {
      flash(req, 'error', problem);
      return res.redirect(back);
    }

    // Stamp the trade with the taker's INFRA proof, so either side can check
    // it with INFRA later, even if Kora's own records were wrong.
    const proof = req.user.claims.find((c) => c.claim_type === 'kyc_verified' && c.proof_hash);
    const id = db.createTrade({
      offerId: offer.id,
      takerId: req.user.id,
      side: offer.side === 'sell' ? 'buy' : 'sell',
      amountUsdc,
      rateNgn: offer.rate_ngn,
      totalNgn: total,
      takerProofHash: proof?.proof_hash || null,
    });
    res.redirect(`/trades/${id}`);
  });

  function loadTradeFor(req, res) {
    const trade = db.getTrade(Number(req.params.id));
    if (!trade || (trade.taker_id !== req.user.id && trade.maker_id !== req.user.id)) {
      res.status(404).render('error', { title: 'Trade not found', message: "This trade doesn't exist or isn't yours.", user: req.user });
      return null;
    }
    return trade;
  }

  router.get('/trades/:id', requireUser, (req, res) => {
    const trade = loadTradeFor(req, res);
    if (!trade) return;
    const { buyerId, sellerId } = roles(trade);
    const iAmTaker = trade.taker_id === req.user.id;
    const ids = identities(trade, req.user.id);
    res.render('trade', {
      mine: ids.mine,
      theirs: ids.theirs,
      bothShared: ids.bothShared,
      title: `Trade #${trade.id}`,
      user: req.user,
      trade,
      iAmTaker,
      iAmBuyer: buyerId === req.user.id,
      iAmSeller: sellerId === req.user.id,
      demo: !trade.maker_id,
      counterpart: iAmTaker
        ? (trade.maker_id ? displayName(trade.maker_first_name, trade.maker_last_name) : trade.demo_name)
        : displayName(trade.taker_first_name, trade.taker_last_name),
      claimLabels: CLAIM_LABELS,
      flash: takeFlash(req),
      ngn,
    });
  });

  router.post('/trades/:id/:action(paid|release|cancel)', requireUser, (req, res) => {
    const trade = loadTradeFor(req, res);
    if (!trade) return;
    const { buyerId, sellerId } = roles(trade);
    const me = req.user.id;
    // Demo traders can't press buttons, so the taker plays their part.
    const actingForDemo = !trade.maker_id && trade.taker_id === me && req.body.as_demo === '1';
    const isBuyer = buyerId === me || (actingForDemo && buyerId === null);
    const isSeller = sellerId === me || (actingForDemo && sellerId === null);
    const { action } = req.params;

    if ((action === 'paid') && trade.status === 'open' && !identities(trade, me).bothShared) {
      flash(req, 'error', 'Both traders need to share their verified name before any money moves.');
    } else if (action === 'paid' && trade.status === 'open' && isBuyer) {
      db.setTradeStatus(trade.id, 'paid');
    } else if (action === 'release' && trade.status === 'paid' && isSeller) {
      db.setTradeStatus(trade.id, 'released');
      flash(req, 'ok', 'Trade complete. USDC released.');
    } else if (action === 'cancel' && trade.status === 'open') {
      db.setTradeStatus(trade.id, 'cancelled');
      flash(req, 'ok', 'Trade cancelled.');
    } else {
      flash(req, 'error', "That step isn't available right now.");
    }
    res.redirect(`/trades/${trade.id}`);
  });

  // Polled by the trade page: reload when the other side acts.
  router.get('/trades/:id/state.json', requireUser, (req, res) => {
    const trade = db.getTrade(Number(req.params.id));
    if (!trade || (trade.taker_id !== req.user.id && trade.maker_id !== req.user.id)) return res.status(404).json({});
    res.json({ state: [trade.status, trade.taker_check_id || '', trade.maker_check_id || ''].join(':') });
  });

  // A trader shares their own verified identity on this trade with a Connect code.
  router.post('/trades/:id/identity', requireUser, async (req, res) => {
    const trade = loadTradeFor(req, res);
    if (!trade) return;
    const back = `/trades/${trade.id}`;
    if (trade.status !== 'open') {
      flash(req, 'error', 'This trade has already moved on.');
      return res.redirect(back);
    }
    const code = normaliseCode(req.body.code);
    if (!code) {
      flash(req, 'error', "That doesn't look like an INFRA Connect code. It looks like CNX-AB12-CD34.");
      return res.redirect(back);
    }
    try {
      const out = await redeemOwnCode({ infra, code, userId: req.user.id, messageFor });
      if (out.error) {
        flash(req, 'error', out.error);
        return res.redirect(back);
      }
      const checkId = db.savePartnerCheck({ checkedBy: req.user.id, ...out.identity });
      db.attachIdentity(trade.id, trade.taker_id === req.user.id ? 'taker' : 'maker', checkId);
      const name = [out.identity.firstName, out.identity.lastName].filter(Boolean).join(' ') || 'Your name';
      flash(req, out.identity.kycStatus === 'verified' ? 'ok' : 'error', out.identity.kycStatus === 'verified'
        ? `${name} is now shown to the other trader as your verified name.`
        : "Your INFRA account isn't verified, so the other trader can't rely on this name. Verify in INFRA Accounts first.");
    } catch (err) {
      flash(req, 'error', messageFor(err));
    }
    res.redirect(back);
  });

  // Ask INFRA directly whether the proof stamped on this trade is still good.
  router.post('/trades/:id/check-proof', requireUser, async (req, res) => {
    const trade = loadTradeFor(req, res);
    if (!trade) return;
    if (!trade.taker_proof_hash) {
      flash(req, 'error', 'This trade has no INFRA proof to check.');
      return res.redirect(`/trades/${trade.id}`);
    }
    try {
      const result = await infra.verifyClaim(trade.taker_proof_hash);
      if (!result.ok) flash(req, 'error', messageFor(result, "INFRA couldn't check this proof right now."));
      else if (result.data?.valid) flash(req, 'ok', 'INFRA confirmed this proof is genuine and still valid.');
      else flash(req, 'error', `INFRA says this proof is no longer valid${result.data?.reason ? ` (${String(result.data.reason).replace(/_/g, ' ')})` : ''}.`);
    } catch (err) {
      flash(req, 'error', messageFor(err));
    }
    res.redirect(`/trades/${trade.id}`);
  });

  return router;
};

module.exports.roles = roles;
