// "Prove it with INFRA": every fact proven on its own (challenge -> proof ->
// check), facts not confirmed shown as such, and a copied proof refused.
const db = require('../server/db');
const { signedIn } = require('./helpers');
const { FACTS, PROOF_SCOPES } = require('../server/routes/zk');
const config = require('../server/config');

const CH = Buffer.alloc(32, 1).toString('base64');
const VALUES = { resident_country: 'NG', resident_state: 'Lagos', postal_region: '100' };
const zk = (overrides = {}) => ({
  zkChallenge: async () => ({ ok: true, status: 201, data: { challenge_id: 'c1', challenge: CH } }),
  zkProof: async (token, userId, challengeId, facts) => ({ ok: true, status: 200, data: { proof: Buffer.alloc(3000).toString('base64'), facts: { [facts[0]]: VALUES[facts[0]] ?? true }, now: '2026-11-06T12:00:00Z', doc_type: 'com.infraidentity.claims.1' } }),
  zkVerify: async ({ challenge }) => ({ ok: true, status: 200, data: { valid: challenge === CH } }),
  ...overrides,
});

beforeEach(() => db.db.exec('DELETE FROM sessions; DELETE FROM trades; DELETE FROM offers; DELETE FROM partner_checks; DELETE FROM merchant_checks; DELETE FROM users;'));

test('Kora asks for every proof permission at sign-in (not as optional)', () => {
  expect(FACTS).toHaveLength(10);
  for (const s of PROOF_SCOPES) expect(config.oauth.scopes.split(' ')).toContain(s);
  expect(config.oauth.optionalScopes).not.toMatch(/proof:/);
});

test('every fact is proven on its own and checked, and a copied proof is refused', async () => {
  const asked = [];
  const { agent } = await signedIn(zk({ zkProof: async (t, u, c, facts) => { asked.push(facts); return zk().zkProof(t, u, c, facts); } }));
  const res = await agent.post('/zk/demo').send({});
  expect(res.body.ok).toBe(true);
  expect(asked).toEqual(FACTS.map((f) => [f]));
  expect(res.body.results.map((r) => r.status)).toEqual(FACTS.map(() => 'proven'));
  expect(res.body.facts).toMatchObject({ age_over_18: true, resident_country: 'NG', resident_state: 'Lagos', postal_region: '100' });
  expect(res.body.copied_proof_refused).toBe(true);
});

test("facts INFRA hasn't confirmed show as not confirmed; the others are still proven", async () => {
  const { agent } = await signedIn(zk({
    zkProof: async (t, u, c, facts) => (['address_verified', 'resident_state'].includes(facts[0])
      ? { ok: false, status: 422, code: 'FACT_NOT_AVAILABLE' }
      : zk().zkProof(t, u, c, facts)),
  }));
  const res = await agent.post('/zk/demo').send({});
  const by = Object.fromEntries(res.body.results.map((r) => [r.fact, r.status]));
  expect(by.address_verified).toBe('not_confirmed');
  expect(by.resident_state).toBe('not_confirmed');
  expect(by.age_over_18).toBe('proven');
  expect(res.body.ok).toBe(true);
});

test('when INFRA has proofs off for Kora, it says so', async () => {
  const { agent } = await signedIn(zk({ zkChallenge: async () => ({ ok: false, status: 404 }) }));
  expect((await agent.post('/zk/demo').send({})).body).toMatchObject({ ok: false, available: false });
});

test.each(['zkChallenge', 'zkProof'])('without any proof permission (%s), it says how to give it', async (step) => {
  const { agent } = await signedIn(zk({ [step]: async () => ({ ok: false, status: 403, code: 'INSUFFICIENT_SCOPE' }) }));
  const res = await agent.post('/zk/demo').send({});
  expect(res.body.ok).toBe(false);
  expect(res.body.message).toMatch(/permission/);
});

test('a proof that fails its check is reported, not hidden', async () => {
  const { agent } = await signedIn(zk({ zkVerify: async () => ({ ok: true, status: 200, data: { valid: false } }) }));
  const res = await agent.post('/zk/demo').send({});
  expect(res.body.ok).toBe(false);
  expect(res.body.results.every((r) => r.status === 'failed')).toBe(true);
  expect(res.body.copied_proof_refused).toBe(null);
});

test('the account page has the button', async () => {
  const { agent } = await signedIn(zk());
  const html = (await agent.get('/account')).text;
  expect(html).toContain('Prove it with INFRA');
  expect(html).toContain('Prove my facts');
});
