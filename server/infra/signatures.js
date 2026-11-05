const crypto = require('crypto');

/**
 * INFRA signs what it sends us with HMAC-SHA256 (hex) using the app's webhook
 * secret:
 *   - webhooks:            X-Webhook-Signature, over the body bytes (canonical JSON)
 *   - deletion callbacks:  X-Deletion-Signature, over the body bytes (JSON)
 * Always check against the raw bytes received, never a re-serialised object.
 */
function hmac(secret, raw) {
  return crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

function verifySignature({ secret, rawBody, signature }) {
  if (!secret || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature) || !rawBody) return false;
  const expected = Buffer.from(hmac(secret, rawBody), 'hex');
  const given = Buffer.from(signature, 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { hmac, verifySignature };
