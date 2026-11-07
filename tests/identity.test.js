const { summariseKyc, tierFor, nextStep } = require('../server/services/identity');

const claim = (t) => ({ claim_type: t });

describe('summariseKyc', () => {
  test('picks the highest verified record', () => {
    expect(summariseKyc([
      { kyc_level: 'level_1', status: 'verified', verified_at: 'a', provider: 'x' },
      { kyc_level: 'level_2', status: 'verified', verified_at: 'b', provider: 'y' },
      { kyc_level: 'level_2', status: 'rejected' },
    ])).toMatchObject({ kyc_level: 'level_2', kyc_status: 'verified', verified_at: 'b' });
  });

  test('no records means not started', () => {
    expect(summariseKyc([])).toMatchObject({ kyc_status: 'not_started', kyc_level: null });
  });

  test('pending stays pending, never verified', () => {
    expect(summariseKyc([{ kyc_level: 'level_1', status: 'pending' }])).toMatchObject({ kyc_status: 'pending', verified_at: null });
  });
});

describe('tierFor', () => {
  test('unverified people can only browse', () => {
    expect(tierFor({ kyc_status: 'pending', kyc_level: 'level_1', claims: [] }).id).toBe('browse');
    expect(tierFor({ kyc_status: 'suspended', kyc_level: 'level_2', claims: [claim('age_over_18')] }).id).toBe('browse');
  });

  test('level 1 verified is Starter', () => {
    expect(tierFor({ kyc_status: 'verified', kyc_level: 'level_1', claims: [] })).toMatchObject({ id: 'starter', limitUsd: 500 });
  });

  test('level 1 + address + over 18 is Full', () => {
    expect(tierFor({ kyc_status: 'verified', kyc_level: 'level_1', claims: [claim('address_verified'), claim('age_over_18')] }).id).toBe('full');
  });

  test('level 2 still needs the over-18 claim for Full', () => {
    expect(tierFor({ kyc_status: 'verified', kyc_level: 'level_2', claims: [] }).id).toBe('starter');
    expect(tierFor({ kyc_status: 'verified', kyc_level: 'level_2', claims: [claim('age_over_18')] }).id).toBe('full');
  });
});

describe('nextStep', () => {
  test('says what is missing for Full', () => {
    expect(nextStep({ kyc_status: 'verified', kyc_level: 'level_1', claims: [] })).toBe('To trade up to $5,000, verify your address and confirm you are over 18 in INFRA Accounts.');
  });
  test('nothing to do at Full', () => {
    expect(nextStep({ kyc_status: 'verified', kyc_level: 'level_2', claims: [claim('age_over_18')] })).toBeNull();
  });
  test('explains a rejected verification', () => {
    expect(nextStep({ kyc_status: 'rejected', claims: [] })).toMatch(/could not verify/);
  });
});
