const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const db = require('../db');
const { tierFor, nextStep, CLAIM_LABELS } = require('../services/identity');
const { requireUser, takeFlash } = require('../services/session');

module.exports = function accountRoutes() {
  const router = express.Router();

  // What INFRA shared with Kora, and how to take it back.
  router.get('/account', requireUser, (req, res) => {
    res.render('account', {
      title: 'Your details',
      user: req.user,
      tier: tierFor(req.user),
      next: nextStep(req.user),
      scopes: req.session.scopes || [],
      signedInWithInfra: Boolean(req.session.tokens),
      claimLabels: CLAIM_LABELS,
      accountsUrl: config.accountsUrl,
      flash: takeFlash(req),
    });
  });

  router.post('/account/delete', requireUser, (req, res) => {
    db.forgetUser(req.user.id);
    req.session.destroy(() => {
      res.clearCookie('kora.sid');
      res.redirect('/?deleted=1');
    });
  });

  // ── Developer panel: what Kora sent to INFRA and what INFRA sent back ──────
  function devAllowed(req) {
    if (config.devPanelKey) {
      const given = Buffer.from(String(req.query.key || req.cookies.kora_dev || ''));
      const want = Buffer.from(config.devPanelKey);
      return given.length === want.length && crypto.timingSafeEqual(given, want);
    }
    return !config.isProduction;
  }

  router.get('/dev', (req, res) => {
    if (!devAllowed(req)) {
      return res.status(404).render('error', { title: 'Page not found', message: "This page doesn't exist." });
    }
    if (req.query.key) {
      res.cookie('kora_dev', String(req.query.key), { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 8 * 3600 * 1000 });
      return res.redirect('/dev');
    }
    const base = `${req.protocol}://${req.get('host')}`;
    res.render('dev', {
      title: 'Developer panel',
      user: req.session.userId ? db.getUser(req.session.userId) : null,
      calls: db.listApiCalls(),
      webhooks: db.listWebhooks(),
      signed: req.session.userId ? db.latestSignedItems(req.session.userId) : null,
      setup: {
        main: Boolean(config.oauth.clientId && config.oauth.clientSecret),
        payv: Boolean(config.payv.clientId && config.payv.clientSecret),
        webhook: Boolean(config.webhookSecret),
        apiBase: config.apiBase,
        redirectUri: config.oauth.redirectUri,
        scopes: config.oauth.scopes,
        webhookUrl: `${base}/webhooks/infra`,
        deletionUrl: `${base}/webhooks/deletion`,
      },
    });
  });

  return router;
};
