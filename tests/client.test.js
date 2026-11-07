const { createInfraClient, InfraUnavailable, redactPath } = require('../server/infra/client');

describe('INFRA client', () => {
  test('returns INFRA error codes without throwing, and logs the call', async () => {
    const log = jest.fn();
    const http = { request: jest.fn().mockResolvedValue({ status: 402, data: { success: false, error: { code: 'PAYMENT_REQUIRED', message: 'Pay' }, payment_request_id: 'pr_1' } }) };
    const infra = createInfraClient({ http, log });

    const res = await infra.payvVerification({ infraUserId: 'u1', scopes: ['kyc:status'], idempotencyKey: 'k1' });

    expect(res).toMatchObject({ ok: false, status: 402, code: 'PAYMENT_REQUIRED', message: 'Pay' });
    expect(res.body.payment_request_id).toBe('pr_1');
    const sent = http.request.mock.calls[0][0];
    expect(sent.url).toBe('https://api.infra.test/api/v1/payv/verification');
    expect(sent.headers.Authorization).toBe('Basic ' + Buffer.from('kora-merchant:payv-secret').toString('base64'));
    expect(sent.headers['Idempotency-Key']).toBe('k1');
    expect(sent.headers['X-PAYMENT']).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ app: 'payv', method: 'POST', path: '/api/v1/payv/verification', status: 402, code: 'PAYMENT_REQUIRED' }));
  });

  test('token exchange uses Basic auth and a form body with the PKCE verifier', async () => {
    const http = { request: jest.fn().mockResolvedValue({ status: 200, data: { access_token: 'a' } }) };
    await createInfraClient({ http }).exchangeCode({ code: 'c', codeVerifier: 'v' });
    const sent = http.request.mock.calls[0][0];
    expect(sent.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(sent.headers.Authorization).toBe('Basic ' + Buffer.from('kora-main:main-secret').toString('base64'));
    expect(new URLSearchParams(sent.data).get('code_verifier')).toBe('v');
    expect(new URLSearchParams(sent.data).get('client_secret')).toBeNull();
  });

  test('network failures throw InfraUnavailable with a plain message', async () => {
    const http = { request: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    await expect(createInfraClient({ http }).me('t')).rejects.toBeInstanceOf(InfraUnavailable);
  });

  test('user ids are hidden in logged paths', () => {
    expect(redactPath('/api/v1/users/11111111-2222-3333-4444-555555555555/kyc')).toBe('/api/v1/users/:id/kyc');
  });
});

describe('verifying signed Connect results', () => {
  const http = require('http');
  const crypto = require('crypto');
  const { SignJWT, exportJWK } = require('jose');
  const config = require('../server/config');

  let server; let key; let other; const saved = config.apiBase;
  beforeAll(async () => {
    key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = { ...(await exportJWK(key.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise((r) => server.listen(0, r));
    config.apiBase = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => { config.apiBase = saved; server.close(); });

  const sign = (privateKey, { aud = 'kora-main', typ = 'infra-connect+jwt' } = {}) =>
    new SignJWT({ data: { profile: { first_name: 'Sam' } } })
      .setProtectedHeader({ alg: 'ES256', typ, kid: 'k1' })
      .setIssuer('https://api.infraidentity.com').setSubject('u1').setAudience(aud).setJti('req_1')
      .setIssuedAt().setExpirationTime('1h')
      .sign(privateKey);

  test('a genuine result for Kora verifies against INFRA’s published keys', async () => {
    const payload = await createInfraClient().verifyConnectResult(await sign(key.privateKey));
    expect(payload).toMatchObject({ sub: 'u1', jti: 'req_1', data: { profile: { first_name: 'Sam' } } });
  });

  test('a result signed by someone else, or for another app, is refused', async () => {
    const infra = createInfraClient();
    await expect(infra.verifyConnectResult(await sign(other.privateKey))).rejects.toThrow();
    await expect(infra.verifyConnectResult(await sign(key.privateKey, { aud: 'another-app' }))).rejects.toThrow();
    await expect(infra.verifyConnectResult(await sign(key.privateKey, { typ: 'dc+sd-jwt' }))).rejects.toThrow();
  });
});
