/**
 * A stand-in for server/infra/client.js. Every method answers like INFRA's
 * API ({ ok, status, body, data, code, message }); tests override per case.
 */
const ok = (data, status = 200) => ({ ok: true, status, body: { success: true, data }, data, code: null, message: null });
const fail = (status, code, message, extra = {}) => ({
  ok: false, status, body: { success: false, error: { code, message }, ...extra }, data: undefined, code, message,
});

function fakeInfra(overrides = {}) {
  const user = {
    id: '11111111-2222-3333-4444-555555555555',
    profile: { email: 'nina@example.com', first_name: 'Nina', last_name: 'Hart', country: 'US', username: 'nina', profile_url: 'https://infraidentity.com/@nina' },
    kyc: [{ kyc_level: 'level_1', status: 'verified', verified_at: '2026-05-01T10:00:00Z', provider: 'dojah' }],
    claims: [
      { claim_type: 'kyc_verified', provider: 'infra', proof_hash: '0xproofhash000000000000000000000001', expires_at: null },
      { claim_type: 'age_over_18', provider: 'infra', proof_hash: '0xproofhash000000000000000000000002', expires_at: null },
    ],
  };
  const calls = [];
  const track = (name, fn) => (...args) => { calls.push({ name, args }); return Promise.resolve(fn(...args)); };

  const infra = {
    user,
    calls,
    authorizeUrl: ({ state, codeChallenge, optional = true }) => `https://hydra.test/oauth2/auth?state=${state}&code_challenge=${codeChallenge}${optional ? '&optional=1' : ''}`,
    exchangeCode: track('exchangeCode', () => ({ ok: true, status: 200, body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'profile:read kyc:read claims:read documents:metadata' } })),
    refreshToken: track('refreshToken', () => ({ ok: true, status: 200, body: { access_token: 'at-2', expires_in: 3600 } })),
    me: track('me', () => ok({ userId: user.id, scope: 'profile:read kyc:read' })),
    profile: track('profile', () => ok({ user_id: user.id, ...user.profile })),
    kyc: track('kyc', () => (user.kyc.length ? ok({ user_id: user.id, kyc_records: user.kyc }) : fail(404, 'KYC_NOT_FOUND', 'No KYC profile found for user'))),
    claims: track('claims', () => ok({ user_id: user.id, claims: user.claims })),
    phone: track('phone', () => (user.phone ? ok({ user_id: user.id, ...user.phone }) : fail(404, 'NO_PHONE_NUMBER', 'No phone number'))),
    documents: track('documents', () => ok({ user_id: user.id, documents: [{ document_type: 'passport', status: 'verified', expiry_date: '2030-01-01', verified_at: '2026-05-01' }] })),
    redeemConnectCode: track('redeemConnectCode', ({ app }) => ok({
      status: 'approved',
      request_id: 'req_1',
      user_id: app === 'payv' ? 'sandbox-user-1' : user.id,
      data: app === 'payv' ? {} : {
        profile: { first_name: 'Nina', last_name: 'Hart', email: 'nina@example.com', country: 'US', username: 'nina' },
        kyc: { kyc_level: 'level_1', status: 'verified', verified_at: '2026-04-01T00:00:00Z', provider: 'dojah' },
      },
      issued_at: '2026-10-21T00:00:00Z',
      signature: 'abc',
    })),
    verifyConnectResult: track('verifyConnectResult', () => ({
      sub: user.id,
      jti: 'req_1',
      data: { profile: { first_name: 'Nina', last_name: 'Hart', country: 'US' }, kyc: { kyc_level: 'level_1', status: 'verified' } },
    })),
    verifyClaim: track('verifyClaim', () => ok({ valid: true, claim_type: 'kyc_verified' })),
    acknowledgeDeletion: track('acknowledgeDeletion', () => ok({ acknowledged: true })),
    payvVerification: track('payvVerification', ({ xPayment, payerAddress }) => (xPayment
      ? ok({ payment_request_id: 'pr_1', status: 'consumed', tx_hash: '0xtx1234567890abcdef', profile: { first_name: 'Sade', last_name: 'Ade', country: 'NG' }, kyc: { kyc_level: 'level_1', status: 'verified', verified_at: '2026-03-01T00:00:00Z' } })
      : fail(402, 'PAYMENT_REQUIRED', 'Payment is required', {
        payment_request_id: 'pr_1', amount_display: '0.95', asset_symbol: 'USDC', payer_requirement: 'any',
        ...(payerAddress ? { payer_address: payerAddress.toLowerCase() } : {}),
        accepts: [{ scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '950000', payTo: '0x000000000000000000000000000000000000dEaD', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', maxTimeoutSeconds: 300 }],
      }))),
    startWalletLink: track('startWalletLink', () => ok({ challenge_id: 'ch_1', message: 'Link wallet to INFRA' })),
    signWalletLink: track('signWalletLink', () => ok({ challenge_id: 'ch_1', status: 'pending' })),
    walletLinkStatus: track('walletLinkStatus', () => ok({ challenge_id: 'ch_1', status: 'linked' })),
    ...overrides,
  };
  return infra;
}

module.exports = { fakeInfra, ok, fail };
