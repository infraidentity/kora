const crypto = require('crypto');

/**
 * Generate PKCE code verifier
 * A cryptographically random string between 43-128 characters
 */
function generateCodeVerifier() {
  return base64URLEncode(crypto.randomBytes(32));
}

/**
 * Generate PKCE code challenge from verifier
 * SHA256 hash of the code verifier, base64url encoded
 */
function generateCodeChallenge(verifier) {
  return base64URLEncode(
    crypto.createHash('sha256').update(verifier).digest()
  );
}

/**
 * Base64URL encode (without padding)
 */
function base64URLEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Generate random state parameter for CSRF protection
 */
function generateState() {
  return base64URLEncode(crypto.randomBytes(32));
}

module.exports = {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState
};
