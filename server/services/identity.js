/**
 * What Kora knows about a trader comes from INFRA, and what they may do on
 * Kora follows from it:
 *
 *   Browse     not verified yet            view offers only
 *   Starter    INFRA-verified (level 1)    trades up to $500
 *   Full       level 2, or level 1 plus    trades up to $5,000
 *              an address claim — and
 *              always an over-18 claim
 *
 * Kora's own address rule: Full needs an address INFRA checked within its
 * freshness window. When INFRA says the address is past it
 * (poa_past_default_window), Kora keeps the person on Starter until they
 * refresh it. INFRA leaves that choice to each app.
 */
const LEVEL_RANK = { level_0: 0, level_1: 1, level_2: 2 };

const TIERS = {
  browse: { id: 'browse', name: 'Browse', limitUsd: 0 },
  starter: { id: 'starter', name: 'Starter', limitUsd: 500 },
  full: { id: 'full', name: 'Full', limitUsd: 5_000 },
};

const CLAIM_LABELS = {
  kyc_verified: 'Government ID verified',
  unique_human: 'Unique person',
  age_over_18: 'Over 18',
  country_resident: 'Country of residence',
  state_resident: 'State of residence',
  postal_region: 'Postal region',
  address_verified: 'Address verified',
  phone_verified: 'Phone confirmed',
};

/** The best verified record, or the most relevant unfinished one. */
function summariseKyc(records = []) {
  const byLevel = (a, b) => (LEVEL_RANK[b.kyc_level] || 0) - (LEVEL_RANK[a.kyc_level] || 0);
  const verified = records.filter((r) => r.status === 'verified').sort(byLevel)[0];
  if (verified) {
    return { kyc_level: verified.kyc_level, kyc_status: 'verified', verified_at: verified.verified_at, kyc_provider: verified.provider };
  }
  const latest = [...records].sort(byLevel)[0];
  return latest
    ? { kyc_level: latest.kyc_level, kyc_status: latest.status || 'not_started', verified_at: null, kyc_provider: latest.provider }
    : { kyc_level: null, kyc_status: 'not_started', verified_at: null, kyc_provider: null };
}

const hasClaim = (user, type) => (user?.claims || []).some((c) => c.claim_type === type);

const flagsOf = (user) => (user && user.flags) || {};

function tierFor(user) {
  if (!user || user.kyc_status !== 'verified') return TIERS.browse;
  const level = LEVEL_RANK[user.kyc_level] || 0;
  const addressFresh = !flagsOf(user).address_stale;
  const strong = addressFresh && (level >= 2 || (level >= 1 && hasClaim(user, 'address_verified')));
  if (strong && hasClaim(user, 'age_over_18')) return TIERS.full;
  return level >= 1 ? TIERS.starter : TIERS.browse;
}

/** What the trader needs to do to reach the next tier, in plain words. */
function nextStep(user) {
  const tier = tierFor(user);
  if (tier.id === 'full') return null;
  if (tier.id === 'browse') {
    if (user?.kyc_status === 'pending') return 'INFRA is checking your ID. Trading opens as soon as it finishes; this page updates by itself.';
    if (user?.kyc_status === 'rejected') return 'INFRA could not verify your ID. Try again in INFRA Accounts to start trading.';
    if (user?.kyc_status === 'expired') return 'Your ID has expired, so trading is paused. Verify a valid ID in INFRA Accounts to trade again.';
    if (user?.kyc_status === 'suspended') return 'INFRA has suspended your verification, so trading is paused.';
    return 'Verify your identity in INFRA Accounts to start trading. It is free and takes a few minutes.';
  }
  const missing = [];
  if (flagsOf(user).address_stale) missing.push('refresh your address');
  else if ((LEVEL_RANK[user.kyc_level] || 0) < 2 && !hasClaim(user, 'address_verified')) missing.push('verify your address');
  if (!hasClaim(user, 'age_over_18')) missing.push('confirm you are over 18');
  return `To trade up to $5,000, ${missing.join(' and ')} in INFRA Accounts.`;
}

const fmtDate = (d) => {
  const t = d ? new Date(d) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
};

/** Standing warnings from INFRA's events, in plain words (most urgent first). */
function warnings(user) {
  const f = flagsOf(user);
  const out = [];
  if (f.id_grace) {
    const days = f.id_grace.grace_days_remaining;
    out.push({ tone: 'bad', text: `Your ID expired${fmtDate(f.id_grace.expiry_date) ? ' on ' + fmtDate(f.id_grace.expiry_date) : ''}. You can keep trading for ${days != null ? days + ' more days' : 'a short while'}; after that trading pauses. Verify a valid ID in INFRA Accounts.` });
  } else if (f.id_expiring) {
    const days = f.id_expiring.days_remaining;
    out.push({ tone: 'warn', text: `Your ID expires${fmtDate(f.id_expiring.expiry_date) ? ' on ' + fmtDate(f.id_expiring.expiry_date) : ' soon'}${days != null ? ` (in ${days} days)` : ''}. Renew it in INFRA Accounts to keep trading without a break.` });
  }
  if (f.address_stale) {
    out.push({ tone: 'warn', text: "INFRA checked your address a while ago. Kora's rule is that Full limits need a recent address, so you're on Starter limits until you refresh it in INFRA Accounts." });
  }
  if (user && user.kyc_status === 'rejected' && f.reject_reason) {
    out.push({ tone: 'bad', text: `INFRA said: ${f.reject_reason}` });
  }
  return out;
}

/**
 * Pull everything the person shared with Kora at sign-in. A section INFRA
 * refuses (for example a scope they didn't grant) is left empty, not fatal.
 */
async function syncFromInfra(infra, accessToken, userId) {
  const [profile, kyc, claims, documents, phone] = await Promise.all([
    infra.profile(accessToken, userId),
    infra.kyc(accessToken, userId),
    infra.claims(accessToken, userId),
    infra.documents(accessToken, userId),
    // Only when the person allowed phone:read; 403 / 404 just mean no number.
    typeof infra.phone === 'function' ? infra.phone(accessToken, userId) : Promise.resolve({ ok: false }),
  ]);

  // An expired or revoked token fails every call the same way.
  if (profile.status === 401) {
    const err = new Error('Your INFRA sign-in has expired. Please sign in again.');
    err.code = 'TOKEN_EXPIRED';
    throw err;
  }

  const p = profile.ok ? profile.data : {};
  // INFRA signs the facts it shares (credential). Check the signature with
  // INFRA's public key instead of trusting the plain list alone.
  const credential = claims.ok ? (claims.data?.credential || null) : null;
  let credentialCheck = null;
  if (credential && typeof infra.checkCredential === 'function') {
    const r = await infra.checkCredential(credential);
    credentialCheck = {
      ok: r.ok,
      reason: r.reason || null,
      kid: r.kid || null,
      environment: r.environment || null,
      facts: (r.facts || []).map((f) => f.name),
      expires_at: r.expiresAt || null,
      steps: r.steps || [],
      checked_at: new Date().toISOString(),
    };
  }
  return {
    id: userId,
    email: p.email,
    first_name: p.first_name,
    last_name: p.last_name,
    country: p.country,
    username: p.username,
    profile_url: p.profile_url,
    // 404 KYC_NOT_FOUND means they haven't started verification.
    ...summariseKyc(kyc.ok ? kyc.data?.kyc_records : []),
    claims: claims.ok ? (claims.data?.claims || []) : [],
    documents: documents.ok ? (documents.data?.documents || []) : [],
    phone: phone.ok && phone.data?.phone_number
      ? { number: phone.data.phone_number, verified: phone.data.phone_verified === true }
      : null,
    credential,
    credential_check: credentialCheck,
  };
}

module.exports = { TIERS, CLAIM_LABELS, LEVEL_RANK, summariseKyc, tierFor, nextStep, warnings, hasClaim, syncFromInfra };
