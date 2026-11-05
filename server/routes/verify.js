const express = require('express');
const config = require('../config');
const credentials = require('../infra/credential');
const { currentUser } = require('../services/session');

/**
 * Check something INFRA signed, online: paste a verified facts credential
 * or a Connect result and see each check. Same code as the scripts in
 * scripts/ and as Kora itself (server/infra/credential.js). Open to anyone,
 * stores nothing, and only ever fetches INFRA's own public keys.
 */
const MAX_LEN = 20000;

module.exports = function verifyRoutes() {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '64kb' });

  const render = (req, res, extra = {}) => res.render('verify', {
    title: 'Check an INFRA signature',
    user: currentUser(req),
    jwksUrl: `${config.apiBase}/.well-known/jwks.json`,
    defaultClientId: config.oauth.clientId || '',
    input: '',
    clientId: config.oauth.clientId || '',
    live: false,
    result: null,
    kind: null,
    ...extra,
  });

  router.get('/verify', (req, res) => render(req, res));

  router.post('/verify', form, async (req, res) => {
    const input = String(req.body.signed || '').trim().slice(0, MAX_LEN);
    const clientId = String(req.body.client_id || '').trim().slice(0, 200);
    const live = req.body.live === '1';
    if (!input) return render(req, res, { input, clientId, live, error: 'Paste a credential or a Connect result first.' });

    const opts = { jwks: credentials.remoteJwks(config.apiBase), issuer: config.issuer, audience: clientId || undefined };
    // A facts credential has "~" between its parts; a Connect result doesn't.
    const kind = input.includes('~') ? 'credential' : 'connect';
    let result;
    try {
      result = kind === 'credential'
        ? await credentials.checkCredential(input, { ...opts, expectEnvironment: live ? 'live' : undefined })
        : await credentials.checkConnectResult(input, opts);
    } catch (err) {
      result = { ok: false, reason: `Could not check it: ${err.message}`, steps: [] };
    }
    render(req, res, { input, clientId, live, kind, result });
  });

  return router;
};
