const axios = require('axios');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const config = require('../config');
const { checkCredential } = require('./credential');

/**
 * Every call Kora makes to INFRA goes through here, so each one is logged on
 * the developer panel (/dev) and failures come back in one shape:
 *   { ok, status, body, code, message }
 * HTTP errors never throw (a 402 from PayV is a normal step, not a failure).
 * Only a network failure throws, as InfraUnavailable.
 */
class InfraUnavailable extends Error {
  constructor(cause) {
    super("Kora can't reach INFRA right now. Please try again in a moment.");
    this.code = 'INFRA_UNREACHABLE';
    this.cause = cause;
  }
}

const basic = (id, secret) => 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');

// Hide user ids and codes in logged paths: the panel is for seeing traffic,
// not for collecting who used Kora.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const redactPath = (p) => p.replace(UUID_RE, ':id').replace(/\?.*$/, '');

function createInfraClient({ http = axios, log = () => {} } = {}) {
  let jwks = null; // INFRA's public keys, fetched once and cached by jose
  async function call(app, method, url, { data, headers = {}, form = false } = {}) {
    const started = Date.now();
    const path = url.startsWith(config.apiBase) ? url.slice(config.apiBase.length) : new URL(url).pathname;
    let res;
    try {
      res = await http.request({
        method,
        url,
        data: form ? new URLSearchParams(data).toString() : data,
        headers: {
          ...(data !== undefined ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
          ...headers,
        },
        timeout: 15000,
        validateStatus: () => true,
      });
    } catch (err) {
      log({ app, method: method.toUpperCase(), path: redactPath(path), status: null, code: 'NETWORK', ms: Date.now() - started });
      throw new InfraUnavailable(err);
    }

    const body = res.data && typeof res.data === 'object' ? res.data : {};
    const ok = res.status >= 200 && res.status < 300;
    // INFRA's API answers { success, data } / { success: false, error: { code, message } };
    // Hydra answers { error, error_description }.
    const code = ok ? null : (body.error?.code || (typeof body.error === 'string' ? body.error : null) || `HTTP_${res.status}`);
    const message = ok ? null : (body.error?.message || body.error_description || body.message || null);
    log({ app, method: method.toUpperCase(), path: redactPath(path), status: res.status, code, ms: Date.now() - started });
    return { ok, status: res.status, body, data: body.data, code, message };
  }

  const mainAuth = () => ({ Authorization: basic(config.oauth.clientId, config.oauth.clientSecret) });
  const payvAuth = () => ({ Authorization: basic(config.payv.clientId, config.payv.clientSecret) });
  const bearer = (token) => ({ Authorization: `Bearer ${token}` });
  const api = (p) => `${config.apiBase}/api/v1${p}`;

  return {
    // ── Sign in with INFRA (OAuth 2.0 + PKCE) ──────────────────────────────
    authorizeUrl({ state, codeChallenge, optional = true }) {
      const url = new URL(config.oauth.authUrl);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.oauth.clientId,
        redirect_uri: config.oauth.redirectUri,
        scope: [config.oauth.scopes, optional ? config.oauth.optionalScopes : ''].filter(Boolean).join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },
    exchangeCode({ code, codeVerifier }) {
      return call('oauth', 'post', config.oauth.tokenUrl, {
        form: true,
        data: { grant_type: 'authorization_code', code, redirect_uri: config.oauth.redirectUri, code_verifier: codeVerifier },
        headers: mainAuth(),
      });
    },
    refreshToken(refreshToken) {
      return call('oauth', 'post', config.oauth.tokenUrl, {
        form: true,
        data: { grant_type: 'refresh_token', refresh_token: refreshToken },
        headers: mainAuth(),
      });
    },

    // ── Data the person shared at sign-in (Bearer token) ───────────────────
    me: (token) => call('main', 'get', api('/users/me'), { headers: bearer(token) }),
    profile: (token, userId) => call('main', 'get', api(`/users/${userId}/profile`), { headers: bearer(token) }),
    kyc: (token, userId) => call('main', 'get', api(`/users/${userId}/kyc`), { headers: bearer(token) }),
    claims: (token, userId) => call('main', 'get', api(`/users/${userId}/claims`), { headers: bearer(token) }),
    documents: (token, userId) => call('main', 'get', api(`/users/${userId}/documents/metadata`), { headers: bearer(token) }),
    phone: (token, userId) => call('main', 'get', api(`/users/${userId}/phone`), { headers: bearer(token) }),

    // ── App-to-INFRA calls (Basic client credentials) ──────────────────────
    // billing: 'payv' records consent only (no data, nothing counted on the
    // plan); the data is then paid for through PAYV.
    redeemConnectCode({ code, scopes, app = 'main', billing }) {
      return call(app, 'post', api('/connect/request'), {
        data: { connect_code: code, scopes, ...(billing ? { billing } : {}) },
        headers: app === 'payv' ? payvAuth() : mainAuth(),
      });
    },
    /**
     * Check a Connect result's signed_result (ES256 JWT) against INFRA's
     * public keys, offline. Returns its payload; throws if it isn't genuine,
     * was issued to another app, or has expired.
     */
    /**
     * Check the person's verified facts credential (SD-JWT) against INFRA's
     * public keys, offline. Never throws; see infra/credential.js.
     */
    checkCredential(credential, { clientId = config.oauth.clientId } = {}) {
      jwks = jwks || createRemoteJWKSet(new URL(`${config.apiBase}/.well-known/jwks.json`));
      return checkCredential(credential, { jwks, issuer: config.issuer, audience: clientId });
    },
    async verifyConnectResult(signedResult, { clientId = config.oauth.clientId } = {}) {
      jwks = jwks || createRemoteJWKSet(new URL(`${config.apiBase}/.well-known/jwks.json`));
      const { payload } = await jwtVerify(signedResult, jwks, {
        algorithms: ['ES256'],
        typ: 'infra-connect+jwt',
        issuer: config.issuer,
        audience: clientId,
      });
      return payload;
    },
    verifyClaim: (proofHash) => call('main', 'post', api('/claims/verify'), { data: { proof_hash: proofHash }, headers: mainAuth() }),
    acknowledgeDeletion: (deletionRequestId) =>
      call('main', 'post', api('/deletion/acknowledge'), { data: { deletion_request_id: deletionRequestId }, headers: mainAuth() }),

    // ── PayV (merchant app credentials) ────────────────────────────────────
    payvVerification({ infraUserId, scopes, paymentRequestId, payerAddress, xPayment, idempotencyKey }) {
      return call('payv', 'post', api('/payv/verification'), {
        data: {
          infra_user_id: infraUserId,
          scopes,
          ...(payerAddress ? { payer_address: payerAddress } : {}),
          ...(paymentRequestId ? { payment_request_id: paymentRequestId } : {}),
        },
        headers: {
          ...payvAuth(),
          ...(xPayment ? { 'X-PAYMENT': xPayment } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
      });
    },
    startWalletLink: ({ paymentRequestId, address }) =>
      call('payv', 'post', api('/payv/wallet-links'), { data: { payment_request_id: paymentRequestId, address }, headers: payvAuth() }),
    signWalletLink: ({ challengeId, paymentRequestId, signature }) =>
      call('payv', 'post', api(`/payv/wallet-links/${encodeURIComponent(challengeId)}/signature`), {
        data: { payment_request_id: paymentRequestId, signature },
        headers: payvAuth(),
      }),
    walletLinkStatus: ({ challengeId, paymentRequestId }) =>
      call('payv', 'get', api(`/payv/wallet-links/${encodeURIComponent(challengeId)}?payment_request_id=${encodeURIComponent(paymentRequestId)}`), {
        headers: payvAuth(),
      }),
  };
}

module.exports = { createInfraClient, InfraUnavailable, redactPath };
