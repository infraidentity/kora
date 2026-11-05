/**
 * Helpers for the signed-in trader: who they are, a working access token,
 * and one-shot messages shown on the next page.
 */
const db = require('../db');

function currentUser(req) {
  return req.session.userId ? db.getUser(req.session.userId) : null;
}

function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    // Signed out, or INFRA told us to forget them (access revoked / deleted).
    if (req.session.userId) req.session.userId = null;
    const wantsJson = req.path.endsWith('.json') || req.is('application/json') || (req.get('accept') || '').includes('application/json');
    if (wantsJson) {
      return res.status(401).json({ ok: false, message: 'Please sign in again.' });
    }
    return res.redirect('/?signin=1');
  }
  req.user = user;
  next();
}

/**
 * The access token for INFRA calls, refreshed when it is about to expire.
 * Returns null when the trader has to sign in again.
 */
async function accessToken(req, infra) {
  const t = req.session.tokens;
  if (!t) return null;
  if (t.expiresAt - 60_000 > Date.now()) return t.accessToken;
  if (!t.refreshToken) return null;

  const res = await infra.refreshToken(t.refreshToken);
  if (!res.ok) {
    req.session.tokens = null;
    return null;
  }
  req.session.tokens = {
    accessToken: res.body.access_token,
    // INFRA may rotate the refresh token; keep the old one if it doesn't.
    refreshToken: res.body.refresh_token || t.refreshToken,
    expiresAt: Date.now() + (Number(res.body.expires_in) || 3600) * 1000,
  };
  return req.session.tokens.accessToken;
}

function flash(req, type, text) {
  req.session.flash = { type, text };
}

function takeFlash(req) {
  const f = req.session.flash || null;
  if (f) delete req.session.flash;
  return f;
}

module.exports = { currentUser, requireUser, accessToken, flash, takeFlash };
