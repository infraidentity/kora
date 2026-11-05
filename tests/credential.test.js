// Kora's check of INFRA-signed things (server/infra/credential.js), and the
// scripts that run the same check. Credentials are built exactly the way
// INFRA builds them (api_server/services/claim-credential.service.js), signed
// with a throwaway key.

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } = require('jose');
const { checkCredential, checkConnectResult } = require('../server/infra/credential');

const ISSUER = 'https://api.infraidentity.com';
const CLIENT = 'infra_live_kora';
const b64url = (b) => Buffer.from(b).toString('base64url');

let privateKey;
let jwks;
let publicJwk;

beforeAll(async () => {
  const kp = await generateKeyPair('ES256');
  privateKey = kp.privateKey;
  publicJwk = { ...(await exportJWK(kp.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  jwks = createLocalJWKSet({ keys: [publicJwk] });
});

async function makeCredential({ environment = 'live', aud = CLIENT, facts = ['age_over_18', 'kyc_verified'], key } = {}) {
  const disclosures = facts.map((name) => b64url(JSON.stringify([b64url(crypto.randomBytes(16)), name, { verified: true, provider: 'infra', issued_at: '2026-10-01T00:00:00.000Z', expires_at: null }])));
  const digests = disclosures.map((d) => crypto.createHash('sha256').update(d, 'ascii').digest('base64url')).sort();
  const jwt = await new SignJWT({ vct: 'https://infraidentity.com/credentials/verified-claims/v1', environment, _sd_alg: 'sha-256', _sd: digests })
    .setProtectedHeader({ alg: 'ES256', typ: 'dc+sd-jwt', kid: 'test-key' })
    .setIssuer(ISSUER).setSubject('person-1').setAudience(aud).setIssuedAt().setExpirationTime('1h')
    .sign(key || privateKey);
  return { credential: `${jwt}~${disclosures.join('~')}~`, jwt, disclosures };
}

const opts = (extra) => ({ jwks, issuer: ISSUER, audience: CLIENT, ...extra });

test('a genuine live credential checks out, with its facts', async () => {
  const { credential } = await makeCredential();
  const r = await checkCredential(credential, opts({ expectEnvironment: 'live' }));
  expect(r.ok).toBe(true);
  expect(r).toMatchObject({ kid: 'test-key', environment: 'live', subject: 'person-1' });
  expect(r.facts.map((f) => f.name).sort()).toEqual(['age_over_18', 'kyc_verified']);
  expect(r.steps.every((s) => s.ok)).toBe(true);
});

test('only some facts passed on still check out (selective disclosure)', async () => {
  const { jwt, disclosures } = await makeCredential();
  const r = await checkCredential(`${jwt}~${disclosures[0]}~`, opts());
  expect(r.ok).toBe(true);
  expect(r.facts).toHaveLength(1);
});

test('a changed fact is caught', async () => {
  const { jwt, disclosures } = await makeCredential();
  const forged = b64url(JSON.stringify(['salt', 'age_over_21', { verified: true }]));
  const r = await checkCredential(`${jwt}~${disclosures[0]}~${forged}~`, opts());
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/changed or added/);
});

test('a credential not signed by INFRA is refused', async () => {
  const other = await generateKeyPair('ES256');
  const { credential } = await makeCredential({ key: other.privateKey });
  const r = await checkCredential(credential, opts());
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/signature doesn't match/);
});

test('a credential issued to another app is refused', async () => {
  const { credential } = await makeCredential({ aud: 'infra_live_someone_else' });
  const r = await checkCredential(credential, opts());
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/different app/);
});

test('a test user cannot pass as a live verified account', async () => {
  const { credential } = await makeCredential({ environment: 'test' });
  const r = await checkCredential(credential, opts({ expectEnvironment: 'live' }));
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/test user/);
});

test('a Connect result is checked the same way', async () => {
  const token = await new SignJWT({ data: { profile: { first_name: 'Ada' }, kyc: { status: 'verified' } } })
    .setProtectedHeader({ alg: 'ES256', typ: 'infra-connect+jwt', kid: 'test-key' })
    .setIssuer(ISSUER).setSubject('person-1').setAudience(CLIENT).setJti('req_1').setIssuedAt().setExpirationTime('10m')
    .sign(privateKey);
  const r = await checkConnectResult(token, opts());
  expect(r).toMatchObject({ ok: true, subject: 'person-1', requestId: 'req_1' });
  const wrongApp = await checkConnectResult(token, opts({ audience: 'other' }));
  expect(wrongApp.ok).toBe(false);
});

describe('the scripts, run as you would run them', () => {
  let server;
  let api;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    api = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const run = (script, args) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'scripts', script), ...args], { env: { ...process.env, CLIENT_ID: '', INFRA_ISSUER: '' } },
      (err, stdout) => resolve({ code: err ? err.code : 0, out: stdout }));
  });

  test('check-credential.js says VALID for a genuine live credential', async () => {
    const { credential } = await makeCredential();
    const r = await run('check-credential.js', [credential, '--api', api, '--client-id', CLIENT, '--issuer', ISSUER, '--live']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('VALID: signed by INFRA (key test-key), live account.');
    expect(r.out).toContain('• age_over_18');
  });

  test('check-credential.js says NOT VALID for a test user with --live', async () => {
    const { credential } = await makeCredential({ environment: 'test' });
    const r = await run('check-credential.js', [credential, '--api', api, '--client-id', CLIENT, '--live']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('NOT VALID');
  });
});

describe('Your details shows the check', () => {
  const { signedIn } = require('./helpers');
  const ok = (data) => Promise.resolve({ ok: true, status: 200, data, body: { success: true, data } });

  test('a credential that checks out shows "Signed by INFRA"', async () => {
    const { credential } = await makeCredential({ environment: 'test' });
    const { agent } = await signedIn({
      claims: () => ok({ claims: [{ claim_type: 'age_over_18' }], credential }),
      checkCredential: (c) => checkCredential(c, { jwks, issuer: ISSUER, audience: CLIENT }),
    });
    const page = (await agent.get('/account')).text;
    expect(page).toContain('Signed by INFRA ✓');
    expect(page).toContain('test-key');
  });

  test("one that doesn't check out is flagged", async () => {
    const other = await generateKeyPair('ES256');
    const { credential } = await makeCredential({ key: other.privateKey });
    const { agent } = await signedIn({
      claims: () => ok({ claims: [{ claim_type: 'age_over_18' }], credential }),
      checkCredential: (c) => checkCredential(c, { jwks, issuer: ISSUER, audience: CLIENT }),
    });
    expect((await agent.get('/account')).text).toContain("INFRA's signature didn't check out");
  });
});

describe('the online checker (/verify)', () => {
  const request = require('supertest');
  const { createApp } = require('../server/app');
  const { fakeInfra } = require('./fake-infra');
  const credModule = require('../server/infra/credential');

  test('shows VALID for a genuine credential and NOT VALID for a test user with live required', async () => {
    const spy = jest.spyOn(credModule, 'remoteJwks').mockReturnValue(jwks);
    const app = createApp({ infra: fakeInfra() });
    const { credential } = await makeCredential({ environment: 'live' });
    const ok = await request(app).post('/verify').type('form').send({ signed: credential, client_id: CLIENT, live: '1' });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('VALID: signed by INFRA (key test-key)');
    expect(ok.text).toContain('age_over_18');

    const t = await makeCredential({ environment: 'test' });
    const bad = await request(app).post('/verify').type('form').send({ signed: t.credential, client_id: CLIENT, live: '1' });
    expect(bad.text).toContain('NOT VALID');
    expect(bad.text).toContain('test user');
    spy.mockRestore();
  });

  test('is open without signing in', async () => {
    const res = await request(createApp({ infra: fakeInfra() })).get('/verify');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Check an INFRA signature');
  });
});
