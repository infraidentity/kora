const request = require('supertest');
const db = require('../server/db');
const { hmac } = require('../server/infra/signatures');
const { signedIn } = require('./helpers');

const SECRET = process.env.WEBHOOK_SECRET;

// INFRA sends webhooks as canonical JSON (sorted keys) and signs those bytes.
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

function sendWebhook(app, payload, { secret = SECRET } = {}) {
  const body = canonical(payload);
  return request(app)
    .post('/webhooks/infra')
    .set('Content-Type', 'application/json')
    .set('X-Event-Type', payload.event_type)
    .set('X-Webhook-Signature', hmac(secret, body))
    .send(body);
}

let n = 0;
const event = (type, data) => ({ event_type: type, event_id: `evt_${++n}`, timestamp: new Date().toISOString(), data });

beforeEach(() => db.db.exec('DELETE FROM sessions; DELETE FROM trades; DELETE FROM offers; DELETE FROM users; DELETE FROM webhook_events;'));

test('a wrong signature is rejected and changes nothing', async () => {
  const { app, infra } = await signedIn();
  const res = await sendWebhook(app, event('kyc_rejected', { user_id: infra.user.id }), { secret: 'not-the-secret' });
  expect(res.status).toBe(401);
  expect(db.getUser(infra.user.id).kyc_status).toBe('verified');
  expect(db.listWebhooks()[0]).toMatchObject({ signature_ok: 0, outcome: 'Rejected: signature did not match' });
});

test("kyc_verified raises the trader's limit straight away", async () => {
  const { app, agent, infra } = await signedIn();
  db.updateVerification(infra.user.id, { kyc_status: 'pending' });
  expect((await agent.get('/status.json')).body.tier).toBe('browse');

  const res = await sendWebhook(app, event('kyc_verified', { user_id: infra.user.id, kyc_level: 'level_2', status: 'verified', verified_at: '2026-10-21T09:00:00Z' }));
  expect(res.status).toBe(200);
  expect((await agent.get('/status.json')).body).toMatchObject({ kyc_status: 'verified', tier: 'full' });
});

test('the same event delivered twice is handled once', async () => {
  const { app, infra } = await signedIn();
  const e = event('claim_revoked', { user_id: infra.user.id, claim_type: 'age_over_18' });
  await sendWebhook(app, e);
  const again = await sendWebhook(app, e);
  expect(again.body).toEqual({ received: true, duplicate: true });
  expect(db.listWebhooks().filter((w) => w.event_type === 'claim_revoked')).toHaveLength(1);
});

test('claims follow claim_issued and claim_revoked', async () => {
  const { app, infra } = await signedIn();
  await sendWebhook(app, event('claim_issued', { user_id: infra.user.id, claim_type: 'address_verified', proof_hash: '0xaddr' }));
  expect(db.getUser(infra.user.id).claims.map((c) => c.claim_type)).toContain('address_verified');
  await sendWebhook(app, event('claim_revoked', { user_id: infra.user.id, claim_type: 'address_verified' }));
  expect(db.getUser(infra.user.id).claims.map((c) => c.claim_type)).not.toContain('address_verified');
});

test('a suspension via kyc_status_updated stops trading', async () => {
  const { app, agent, infra } = await signedIn();
  await sendWebhook(app, event('kyc_status_updated', { user_id: infra.user.id, status: 'suspended', previous_status: 'verified' }));
  expect((await agent.get('/status.json')).body.tier).toBe('browse');
});

test('consent_revoked deletes the trader and ends their session', async () => {
  const { app, agent, infra } = await signedIn();
  await agent.post('/offers').type('form').send({ side: 'sell', amount_usdc: '100', rate_ngn: '1600' });

  await sendWebhook(app, event('consent_revoked', { user_id: infra.user.id, consent_id: 'c1', app_id: 'a1', reason: 'user_revoked' }));

  expect(db.getUser(infra.user.id)).toBeNull();
  expect(db.listOffers().some((o) => o.user_id === infra.user.id)).toBe(false);
  expect(db.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(infra.user.id).n).toBe(0);
  expect((await agent.get('/status.json')).status).toBe(401);
});

test('events about people Kora never met are ignored', async () => {
  const { app } = await signedIn();
  await sendWebhook(app, event('kyc_verified', { user_id: 'someone-else', kyc_level: 'level_1' }));
  expect(db.getUser('someone-else')).toBeNull();
  expect(db.listWebhooks()[0].outcome).toMatch(/^Ignored: Kora doesn't hold this person/);
});

test('a deletion callback deletes everything and acknowledges', async () => {
  const { app, infra } = await signedIn();
  // Deletion callbacks are signed over JSON.stringify of the payload.
  const payload = { event_type: 'data_deletion_requested', deletion_request_id: 'del_1', user_id: infra.user.id, timestamp: new Date().toISOString(), data_accessed_at: null, scopes_granted: ['profile:read'] };
  const body = JSON.stringify(payload);
  const res = await request(app)
    .post('/webhooks/deletion')
    .set('Content-Type', 'application/json')
    .set('X-Deletion-Signature', hmac(SECRET, body))
    .send(body);

  expect(res.body).toEqual({ acknowledged: true, deletion_request_id: 'del_1' });
  expect(db.getUser(infra.user.id)).toBeNull();
});

test('a deletion callback with a bad signature is refused and deletes nothing', async () => {
  const { app, infra } = await signedIn();
  const res = await request(app)
    .post('/webhooks/deletion')
    .set('Content-Type', 'application/json')
    .set('X-Deletion-Signature', 'f'.repeat(64))
    .send(JSON.stringify({ deletion_request_id: 'del_2', user_id: infra.user.id }));
  expect(res.status).toBe(401);
  expect(db.getUser(infra.user.id)).not.toBeNull();
});

test('data_deletion_requested as a webhook is acknowledged through the API', async () => {
  const { app, infra } = await signedIn();
  await sendWebhook(app, { event_type: 'data_deletion_requested', event_id: 'evt_del', deletion_request_id: 'del_3', user_id: infra.user.id });
  await new Promise((r) => setImmediate(r));
  expect(db.getUser(infra.user.id)).toBeNull();
  expect(infra.calls.find((c) => c.name === 'acknowledgeDeletion').args[0]).toBe('del_3');
});

test('a normal webhook sent to the deletion address is named as such', async () => {
  const { app, infra } = await signedIn();
  const payload = { event_type: 'kyc_status_updated', event_id: 'evt_wrong', data: { user_id: infra.user.id, status: 'verified' } };
  const body = canonical(payload);
  const res = await request(app).post('/webhooks/deletion').set('Content-Type', 'application/json')
    .set('X-Event-Type', 'kyc_status_updated').set('X-Webhook-Signature', hmac(SECRET, body)).send(body);
  expect(res.status).toBe(401);
  expect(db.listWebhooks()[0]).toMatchObject({ event_type: 'kyc_status_updated', outcome: expect.stringMatching(/normal webhook sent to the deletion address/) });
});
