const crypto = require('crypto');
const { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } = require('jose');

/**
 * Check things INFRA signed, offline, with INFRA's public keys
 * (/.well-known/jwks.json). Kora uses these, and so do the scripts in
 * scripts/ (check-credential.js, check-connect-result.js), so what you run
 * by hand is exactly what Kora runs.
 *
 * Verified facts credential (SD-JWT, typ dc+sd-jwt), from
 * GET /api/v1/users/{id}/claims as `credential`:
 *
 *   <signed JWT>~<fact 1>~<fact 2>~...~
 *
 *   The signed JWT carries iss, sub (the person), aud (your client id), iat,
 *   exp, environment ("live" | "test") and _sd: one SHA-256 hash per fact.
 *   Each fact is base64url JSON [salt, name, { verified, provider,
 *   issued_at, expires_at, value? }]; it counts only if its hash is in _sd.
 */
const CREDENTIAL_TYP = 'dc+sd-jwt';
const CONNECT_TYP = 'infra-connect+jwt';

const jwksCache = new Map();
function remoteJwks(apiBase) {
  const url = `${String(apiBase).replace(/\/$/, '')}/.well-known/jwks.json`;
  if (!jwksCache.has(url)) jwksCache.set(url, createRemoteJWKSet(new URL(url)));
  return jwksCache.get(url);
}

const b64urlSha256 = (s) => crypto.createHash('sha256').update(s, 'ascii').digest('base64url');

/**
 * Check a verified facts credential. Never throws: returns
 *   { ok: true, kid, issuer, subject, audience, environment, issuedAt, expiresAt, facts: [{ name, ...value }], steps }
 *   { ok: false, reason, steps }
 * `steps` lists each check and whether it passed, for showing to people.
 */
async function checkCredential(credential, { jwks, apiBase, issuer, audience, expectEnvironment } = {}) {
  const steps = [];
  const fail = (reason) => ({ ok: false, reason, steps });
  const step = (name, ok, detail) => { steps.push({ name, ok, detail: detail || null }); return ok; };

  if (typeof credential !== 'string' || !credential.includes('~')) {
    step('Looks like an INFRA credential (signed part ~ facts ~)', false);
    return fail('This is not an INFRA verified facts credential.');
  }
  const [jwt, ...disclosures] = credential.trim().split('~').filter(Boolean);
  step('Looks like an INFRA credential (signed part ~ facts ~)', true, `${disclosures.length} fact(s) attached`);

  let kid = null;
  try { kid = decodeProtectedHeader(jwt).kid || null; } catch { /* checked below */ }

  let payload;
  try {
    ({ payload } = await jwtVerify(jwt, jwks || remoteJwks(apiBase), {
      algorithms: ['ES256'],
      typ: CREDENTIAL_TYP,
      ...(issuer ? { issuer } : {}),
      ...(audience ? { audience } : {}),
    }));
  } catch (err) {
    const why = {
      ERR_JWS_SIGNATURE_VERIFICATION_FAILED: "INFRA's signature doesn't match: it was changed or not made by INFRA.",
      ERR_JWKS_NO_MATCHING_KEY: `No INFRA public key matches its key id (${kid || 'none'}).`,
      ERR_JWT_EXPIRED: 'It has expired. Fetch the facts again for a fresh one.',
      ERR_JWT_CLAIM_VALIDATION_FAILED: err.claim === 'aud'
        ? 'It was issued to a different app (audience is not your client id).'
        : err.claim === 'iss' ? 'It was issued by someone other than INFRA (issuer mismatch).' : `A required field is wrong (${err.claim}).`,
    }[err.code] || `The signature check failed (${err.code || err.message}).`;
    step("Signed by INFRA's public key", false, why);
    return fail(why);
  }
  step("Signed by INFRA's public key", true, `key ${kid}`);
  if (audience) step('Issued to this app', true, audience);
  if (issuer) step('Issued by INFRA', true, issuer);
  step('Not expired', true, payload.exp ? `until ${new Date(payload.exp * 1000).toISOString()}` : null);

  const environment = payload.environment || 'live';
  if (expectEnvironment && environment !== expectEnvironment) {
    step(`For a ${expectEnvironment} account`, false, `it is a ${environment} credential`);
    return fail(environment === 'test'
      ? 'This credential belongs to a test user, not a live verified account.'
      : 'This credential belongs to a live account, but a test one was expected.');
  }
  step(expectEnvironment ? `For a ${expectEnvironment} account` : 'Account type', true, environment);

  const signed = new Set(Array.isArray(payload._sd) ? payload._sd : []);
  const facts = [];
  for (const d of disclosures) {
    if (!signed.has(b64urlSha256(d))) {
      step('Every fact was signed by INFRA', false, 'one fact is not in the signed list (changed or added)');
      return fail('One of the facts was changed or added after INFRA signed it.');
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.from(d, 'base64url').toString('utf8')); } catch { parsed = null; }
    if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[1] !== 'string') {
      step('Every fact was signed by INFRA', false, 'a fact is not readable');
      return fail('One of the facts is not readable.');
    }
    facts.push({ name: parsed[1], ...(parsed[2] || {}) });
  }
  step('Every fact was signed by INFRA', true, facts.map((f) => f.name).join(', ') || 'no facts attached');

  return {
    ok: true,
    kid,
    issuer: payload.iss,
    subject: payload.sub,
    audience: payload.aud,
    environment,
    issuedAt: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
    expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
    facts,
    steps,
  };
}

/** Check a Connect result's signed_result. Never throws; same shape as above. */
async function checkConnectResult(signedResult, { jwks, apiBase, issuer, audience } = {}) {
  const steps = [];
  let payload;
  let kid = null;
  try { kid = decodeProtectedHeader(signedResult).kid || null; } catch { /* checked below */ }
  try {
    ({ payload } = await jwtVerify(String(signedResult || '').trim(), jwks || remoteJwks(apiBase), {
      algorithms: ['ES256'],
      typ: CONNECT_TYP,
      ...(issuer ? { issuer } : {}),
      ...(audience ? { audience } : {}),
    }));
  } catch (err) {
    const reason = err.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && err.claim === 'aud'
      ? 'It was issued to a different app (audience is not your client id).'
      : err.code === 'ERR_JWT_EXPIRED' ? 'It has expired.'
        : err.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ? "INFRA's signature doesn't match: it was changed or not made by INFRA."
          : `The signature check failed (${err.code || err.message}).`;
    steps.push({ name: "Signed by INFRA's public key", ok: false, detail: reason });
    return { ok: false, reason, steps };
  }
  steps.push({ name: "Signed by INFRA's public key", ok: true, detail: `key ${kid}` });
  if (audience) steps.push({ name: 'Issued to this app', ok: true, detail: audience });
  return { ok: true, kid, subject: payload.sub, requestId: payload.jti, audience: payload.aud, data: payload.data || {}, steps };
}

module.exports = { checkCredential, checkConnectResult, remoteJwks, CREDENTIAL_TYP, CONNECT_TYP };
