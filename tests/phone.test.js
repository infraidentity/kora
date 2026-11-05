const request = require('supertest');
const db = require('../server/db');
const { createApp } = require('../server/app');
const { fakeInfra } = require('./fake-infra');

// Kora asks for the phone number (phone:read) as an optional permission,
// shows it with whether INFRA confirmed it, and keeps it in step with
// INFRA's "access allowed" notice.

beforeEach(() => db.db.exec('DELETE FROM sessions; DELETE FROM trades; DELETE FROM offers; DELETE FROM partner_checks; DELETE FROM merchant_checks; DELETE FROM users;'));

async function signIn(infra) {
  const agent = request.agent(createApp({ infra }));
  const login = await agent.get('/login');
  const state = new URL(login.headers.location).searchParams.get('state');
  await agent.get(`/callback?code=abc&state=${state}`);
  return { agent, login };
}

test('the number and "confirmed by INFRA" show on the account page', async () => {
  const infra = fakeInfra();
  infra.user.phone = { phone_number: '+2348012345678', phone_verified: true };
  infra.user.claims.push({ claim_type: 'phone_verified', provider: 'persona', proof_hash: '0xp3', expires_at: null });
  const { agent } = await signIn(infra);
  expect(db.getUser(infra.user.id).phone).toEqual({ number: '+2348012345678', verified: true });
  const page = await agent.get('/account');
  expect(page.text).toContain('+2348012345678');
  expect(page.text).toContain('Confirmed by INFRA');
  expect(page.text).toContain('Phone confirmed');
});

test('no number shared: sign-in still works and the page says so', async () => {
  const infra = fakeInfra();
  const { agent } = await signIn(infra);
  expect(db.getUser(infra.user.id).phone).toBeNull();
  expect((await agent.get('/account')).text).toContain('Not shared');
});

test("Kora's app doesn't allow the phone permission yet: it signs in again without it", async () => {
  const agent = request.agent(createApp({ infra: fakeInfra() }));
  const first = await agent.get('/login');
  expect(first.headers.location).toContain('optional=1');
  const back = await agent.get('/callback?error=invalid_scope');
  expect(back.status).toBe(302);
  expect(back.headers.location).toBe('/login');
  const again = await agent.get('/login');
  expect(again.headers.location).not.toContain('optional=1');
});

test('the "access allowed" notice updates the number', async () => {
  const { applyEvent } = require('../server/routes/webhooks');
  const infra = fakeInfra();
  await signIn(infra);
  const outcome = applyEvent('consent_granted', { user_id: infra.user.id, phone: { phone_number: '+2348099999999', phone_verified: false } });
  expect(outcome).toContain('phone number');
  expect(db.getUser(infra.user.id).phone).toEqual({ number: '+2348099999999', verified: false });
});
