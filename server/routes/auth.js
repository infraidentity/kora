const express = require('express');
const config = require('../config');
const db = require('../db');
const { generateCodeVerifier, generateCodeChallenge, generateState } = require('../utils/pkce');
const { syncFromInfra } = require('../services/identity');
const { messageFor } = require('../services/messages');

/**
 * Sign in with INFRA: OAuth 2.0 authorization code + PKCE.
 *
 * The state and PKCE verifier live in short-lived httpOnly cookies, not the
 * session, so a restart between leaving for INFRA and coming back doesn't
 * break sign-in.
 */
const OAUTH_COOKIE = { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/' };

module.exports = function authRoutes({ infra }) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    const state = generateState();
    const verifier = generateCodeVerifier();
    const secure = config.isProduction;
    res.cookie('kora_oauth_state', state, { ...OAUTH_COOKIE, secure });
    res.cookie('kora_oauth_verifier', verifier, { ...OAUTH_COOKIE, secure });
    // Set after INFRA refused an optional permission Kora's app doesn't have yet.
    const optional = req.cookies.kora_no_optional_scopes !== '1';
    res.redirect(infra.authorizeUrl({ state, codeChallenge: generateCodeChallenge(verifier), optional }));
  });

  router.get('/callback', async (req, res, next) => {
    const fail = (status, message) => res.status(status).render('error', { title: "Couldn't sign you in", message, retry: '/login' });

    try {
      const { code, state, error } = req.query;
      const storedState = req.cookies.kora_oauth_state;
      const verifier = req.cookies.kora_oauth_verifier;
      res.clearCookie('kora_oauth_state', { path: '/' });
      res.clearCookie('kora_oauth_verifier', { path: '/' });

      if (error === 'access_denied') {
        return fail(400, "You chose not to share your INFRA details with Kora. You can sign in again any time.");
      }
      // Kora's app on INFRA doesn't allow an optional permission (phone:read)
      // yet: sign in again without it, for a day. Turn it on in the developer
      // portal (Your app → permissions) to get the phone number.
      if (error === 'invalid_scope' && config.oauth.optionalScopes && req.cookies.kora_no_optional_scopes !== '1') {
        res.cookie('kora_no_optional_scopes', '1', { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000, path: '/', secure: config.isProduction });
        return res.redirect('/login');
      }
      if (error) return fail(400, 'INFRA could not complete sign-in. Please try again.');
      if (!state || !storedState || state !== storedState || !verifier) {
        return fail(400, 'This sign-in link is old or was opened in another browser. Please sign in again.');
      }

      const token = await infra.exchangeCode({ code, codeVerifier: verifier });
      if (!token.ok) return fail(400, messageFor(token, 'INFRA could not complete sign-in. Please try again.'));
      const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = token.body;

      // Which INFRA user this token belongs to.
      const me = await infra.me(accessToken);
      if (!me.ok || !me.data?.userId) return fail(502, messageFor(me, 'INFRA did not say who signed in. Please try again.'));
      const userId = me.data.userId;

      db.saveUser(await syncFromInfra(infra, accessToken, userId));
      db.seedDemoOffers();

      // New session id on sign-in, so an old cookie can't ride along.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = userId;
        req.session.scopes = String(token.body.scope || me.data.scope || '').split(' ').filter(Boolean);
        req.session.tokens = {
          accessToken,
          refreshToken: refreshToken || null,
          expiresAt: Date.now() + (Number(expiresIn) || 3600) * 1000,
        };
        req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect('/market')));
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('kora.sid');
      res.redirect('/');
    });
  });

  return router;
};
