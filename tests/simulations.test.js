// Every event the INFRA developer portal can simulate for a test user, in
// the shape INFRA sends it ("simulated": true), and what Kora does with it.
// The person starts verified at level 1 with kyc_verified and age_over_18.

const request = require('supertest');
const db = require('../server/db');
const { hmac } = require('../server/infra/signatures');
const { signedIn } = require('./helpers');

const SECRET = process.env.WEBHOOK_SECRET;

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

let n = 0;
function send(app, type, data) {
  const body = canonical({ event_type: type, event_id: `sim_${++n}`, timestamp: new Date().toISOString(), simulated: true, data });
  return request(app).post('/webhooks/infra').set('Content-Type', 'application/json')
    .set('X-Event-Type', type).set('X-Webhook-Signature', hmac(SECRET, body)).send(body);
}

const lastOutcome = () => db.listWebhooks()[0].outcome;

beforeEach(() => db.db.exec('DELETE FROM sessions; DELETE FROM trades; DELETE FROM offers; DELETE FROM users; DELETE FROM webhook_events;'));

async function setup() {
  const s = await signedIn();
  const status = async () => (await s.agent.get('/status.json')).body;
  return { ...s, id: s.infra.user.id, status };
}

test('ID verified', async () => {
  const { app, id, status } = await setup();
  db.updateVerification(id, { kyc_status: 'pending' });
  await send(app, 'kyc_verified', { user_id: id, kyc_level: 'level_1', status: 'verified', provider: 'sandbox' });
  expect((await status()).tier).toBe('starter');
  expect(lastOutcome()).toMatch(/^\[Test event\] ID verified/);
  expect(db.getUser(id).alerts[0]).toMatchObject({ tone: 'ok', simulated: true });
});

test('ID rejected pauses trading and keeps the reason', async () => {
  const { app, id, status, agent } = await setup();
  await send(app, 'kyc_rejected', { user_id: id, status: 'rejected', reject_type: 'RETRY', reject_reason: 'The ID document could not be read.' });
  expect((await status()).tier).toBe('browse');
  const page = await agent.get('/account');
  expect(page.text).toContain('The ID document could not be read.');
});

test('ID expiring soon warns but trading continues', async () => {
  const { app, id, status, agent } = await setup();
  await send(app, 'kyc_status_updated', { user_id: id, status: 'document_expiring_soon', previous_status: 'verified', metadata: { expiry_date: '2026-12-01', days_remaining: 14 } });
  expect(await status()).toMatchObject({ kyc_status: 'verified', tier: 'starter' });
  expect((await agent.get('/market')).text).toContain('(in 14 days)');
});

test('ID expired in grace period warns but trading continues', async () => {
  const { app, id, status, agent } = await setup();
  await send(app, 'kyc_status_updated', { user_id: id, status: 'document_expired_grace_period', metadata: { expiry_date: '2026-11-01', grace_days_remaining: 30 } });
  expect(await status()).toMatchObject({ kyc_status: 'verified', tier: 'starter' });
  expect((await agent.get('/market')).text).toContain('keep trading for 30 more days');
});

test('claims revoked after ID expiry pause trading', async () => {
  const { app, id, status } = await setup();
  await send(app, 'claim_revoked', { user_id: id, claim_type: 'kyc_verified', reason: 'document_expired' });
  expect(await status()).toMatchObject({ kyc_status: 'expired', tier: 'browse' });
  expect(db.getUser(id).claims.map((c) => c.claim_type)).not.toContain('kyc_verified');
});

test('address verified unlocks Full', async () => {
  const { app, id, status } = await setup();
  await send(app, 'kyc_verified', { user_id: id, kyc_level: 'level_2', status: 'verified' });
  expect((await status()).tier).toBe('full');
});

test("address past its freshness window: Kora's own rule keeps Starter", async () => {
  const { app, id, status, agent } = await setup();
  await send(app, 'kyc_verified', { user_id: id, kyc_level: 'level_2', status: 'verified' });
  await send(app, 'kyc_status_updated', { user_id: id, status: 'poa_past_default_window', metadata: { validity_days: 180 } });
  expect(await status()).toMatchObject({ kyc_status: 'verified', tier: 'starter' });
  expect((await agent.get('/market')).text).toContain('refresh your address');
  // A new address check lifts it.
  await send(app, 'kyc_verified', { user_id: id, kyc_level: 'level_2', status: 'verified' });
  expect((await status()).tier).toBe('full');
});

test('address no longer verified drops only the address', async () => {
  const { app, id, status } = await setup();
  await send(app, 'kyc_verified', { user_id: id, kyc_level: 'level_2', status: 'verified' });
  await send(app, 'kyc_rejected', { user_id: id, status: 'rejected', reject_type: 'ADDRESS_WITHDRAWN', reject_reason: 'The address document was withdrawn.' });
  expect(await status()).toMatchObject({ kyc_status: 'verified', tier: 'starter' });
  expect(db.getUser(id).kyc_level).toBe('level_1');
});

test('person removed the app: everything deleted, later events explain why they are ignored', async () => {
  const { app, id, agent } = await setup();
  await send(app, 'consent_revoked', { user_id: id, consent_id: 'c1', app_id: 'a1', reason: 'user_revoked' });
  expect(db.getUser(id)).toBeNull();
  expect((await agent.get('/status.json')).status).toBe(401);
  await send(app, 'kyc_verified', { user_id: id, kyc_level: 'level_1' });
  expect(lastOutcome()).toMatch(/Sign in to Kora with them again/);
});

test('every event is listed for the person under "What INFRA told Kora"', async () => {
  const { app, id, agent } = await setup();
  await send(app, 'kyc_status_updated', { user_id: id, status: 'document_expiring_soon', metadata: { days_remaining: 14 } });
  await send(app, 'claim_revoked', { user_id: id, claim_type: 'age_over_18', reason: 'user_request' });
  const page = (await agent.get('/account')).text;
  expect(page).toContain('What INFRA told Kora');
  expect(page).toContain('INFRA withdrew a fact: age over 18');
  expect(page).toContain('test event');
});
