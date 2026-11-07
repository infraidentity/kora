/**
 * Verified names on a trade, with INFRA Connect.
 *
 * Kora shows traders to each other by first name only. When a trade opens,
 * each trader shares their own verified identity for this trade: they make
 * an INFRA Connect code in INFRA Accounts (valid 10 minutes, single use) and
 * paste it into the trade. Making and handing over the code is their consent.
 * Kora redeems it, checks the code really is theirs, and shows their
 * verified full name to the other side, so the buyer pays into an account in
 * the seller's name and the seller knows whose money to expect.
 *
 * Demo traders can't make codes, so they show a sample verified identity.
 */
const SCOPES = ['profile:basic', 'kyc:status'];

/** "cnx ab12 cd34", "AB12CD34" and "CNX-AB12-CD34" all become CNX-AB12-CD34. */
function normaliseCode(input) {
  let s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('CNX')) s = s.slice(3);
  return s.length === 8 ? `CNX-${s.slice(0, 4)}-${s.slice(4)}` : null;
}

/**
 * Redeem a trader's own Connect code. Returns { identity } or { error } (a
 * plain sentence). The signed copy of the result wins over the plain one,
 * and must be this very request for this very person.
 */
async function redeemOwnCode({ infra, code, userId, messageFor }) {
  const result = await infra.redeemConnectCode({ code, scopes: SCOPES });
  if (!result.ok) {
    return {
      error: result.code === 'VERIFICATION_REQUIRED'
        ? "Your INFRA account isn't verified yet, so there's no verified name to share. Verify your ID in INFRA Accounts first."
        : messageFor(result, "INFRA couldn't check that code. Make a new one in INFRA Accounts."),
    };
  }
  const d = result.data || {};
  if (d.user_id !== userId) {
    return { error: 'That code belongs to someone else. Make a code from your own INFRA account (Connect an app in INFRA Accounts).' };
  }

  let shared = d.data || {};
  let signed = false;
  if (d.signed_result) {
    try {
      const proof = await infra.verifyConnectResult(d.signed_result);
      if (proof.jti !== d.request_id || proof.sub !== d.user_id) throw new Error('mismatch');
      shared = proof.data || {};
      signed = true;
    } catch {
      return { error: "INFRA's signature on this result didn't check out, so Kora ignored it. Make a new code." };
    }
  }
  const profile = shared.profile || {};
  const kyc = shared.kyc || {};
  return {
    identity: {
      requestId: d.request_id || null,
      infraUserId: d.user_id,
      firstName: profile.first_name || null,
      lastName: profile.last_name || null,
      country: profile.country || null,
      username: profile.username || null,
      kycLevel: kyc.kyc_level || null,
      kycStatus: kyc.status || 'not_started',
      verifiedAt: kyc.verified_at || null,
      signed: signed ? 1 : 0,
      signedResult: signed ? d.signed_result : null,
    },
  };
}

// Where each demo trader (sample) is from.
const SAMPLE_COUNTRY = { Lena: 'DE', Mateo: 'ES', Priya: 'IN', Kenji: 'JP' };

/** A demo trader's sample identity ("Demo trader · Lena" → Lena). */
function sampleIdentity(demoName) {
  const first = String(demoName || '').split('·').pop().trim() || 'Demo';
  return { first_name: first, last_name: 'Demo', kyc_status: 'verified', kyc_level: 'level_1', country: SAMPLE_COUNTRY[first] || 'US', sample: true };
}

module.exports = { SCOPES, normaliseCode, redeemOwnCode, sampleIdentity };
