// "Prove it with INFRA": challenge -> proof -> check, plus a copied proof refused.
const db = require('../server/db');
const { signedIn } = require('./helpers');

const CH = Buffer.alloc(32, 1).toString('base64');
const zk = (overrides = {}) => ({
  zkChallenge: async () => ({ ok: true, status: 201, data: { challenge_id: 'c1', challenge: CH } }),
  zkProof: async () => ({ ok: true, status: 200, data: { proof: Buffer.alloc(3000).toString('base64'), facts: { age_over_18: true, kyc_verified: true }, now: '2026-11-06T12:00:00Z', doc_type: 'com.infraidentity.claims.1' } }),
  zkVerify: async ({ challenge }) => ({ ok: true, status: 200, data: { valid: challenge === CH } }),
  ...overrides,
});

beforeEach(() => db.db.exec('DELETE FROM sessions; DELETE FROM trades; DELETE FROM offers; DELETE FROM partner_checks; DELETE FROM merchant_checks; DELETE FROM users;'));

test('the demo shows the facts, the timings, and that a copied proof is refused', async () => {
  const { agent } = await signedIn(zk());
  const res = await agent.post('/zk/demo').send({});
  expect(res.body).toMatchObject({ ok: true, facts: { age_over_18: true, kyc_verified: true }, copied_proof_refused: true });
  expect(res.body.timings).toEqual({ challenge_ms: expect.any(Number), prove_ms: expect.any(Number), verify_ms: expect.any(Number) });
});

test('when INFRA has proofs off for Kora, it says so', async () => {
  const { agent } = await signedIn(zk({ zkChallenge: async () => ({ ok: false, status: 404 }) }));
  expect((await agent.post('/zk/demo').send({})).body).toMatchObject({ ok: false, available: false });
});

test("a person INFRA hasn't verified gets a plain explanation", async () => {
  const { agent } = await signedIn(zk({ zkProof: async () => ({ ok: false, status: 422, code: 'FACT_NOT_AVAILABLE' }) }));
  const res = await agent.post('/zk/demo').send({});
  expect(res.body.ok).toBe(false);
  expect(res.body.message).toMatch(/hasn't confirmed/);
});

test.each(['zkChallenge', 'zkProof'])('without the proof permission (%s), it says how to give it', async (step) => {
  const { agent } = await signedIn(zk({ [step]: async () => ({ ok: false, status: 403, code: 'INSUFFICIENT_SCOPE' }) }));
  const res = await agent.post('/zk/demo').send({});
  expect(res.body.ok).toBe(false);
  expect(res.body.message).toMatch(/permission/);
});

test('the account page has the button', async () => {
  const { agent } = await signedIn(zk());
  expect((await agent.get('/account')).text).toContain('Prove it with INFRA');
});
