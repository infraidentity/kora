const request = require('supertest');
const db = require('../server/db');
const { createApp } = require('../server/app');
const { fakeInfra, fail } = require('./fake-infra');
const { signedIn } = require('./helpers');

beforeEach(() => db.db.exec('DELETE FROM sessions; DELETE FROM trades; DELETE FROM offers; DELETE FROM partner_checks; DELETE FROM merchant_checks; DELETE FROM users;'));

const tradeIdFrom = (res) => Number(res.headers.location.split('/').pop());

async function signInAs(id) {
  const infra = fakeInfra();
  infra.user.id = id;
  const agent = request.agent(createApp({ infra }));
  const state = new URL((await agent.get('/login')).headers.location).searchParams.get('state');
  await agent.get(`/callback?code=abc&state=${state}`);
  return agent;
}

describe('Sign in with INFRA', () => {
  test('/login sends people to INFRA with PKCE and remembers state in cookies', async () => {
    const res = await request(createApp({ infra: fakeInfra() })).get('/login');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookies = res.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/kora_oauth_state=/);
    expect(cookies).toMatch(/kora_oauth_verifier=/);
    expect(cookies).toMatch(/HttpOnly/i);
  });

  test('a mismatched state is refused in plain words', async () => {
    const agent = request.agent(createApp({ infra: fakeInfra() }));
    await agent.get('/login');
    const res = await agent.get('/callback?code=abc&state=wrong');
    expect(res.status).toBe(400);
    expect(res.text).toContain('This sign-in link is old or was opened in another browser');
  });

  test('declining on INFRA explains what happened', async () => {
    const res = await request(createApp({ infra: fakeInfra() })).get('/callback?error=access_denied');
    expect(res.text).toContain('You chose not to share your INFRA details with Kora');
  });

  test('signing in stores what INFRA shared and opens the market', async () => {
    const { agent, infra } = await signedIn();
    const user = db.getUser(infra.user.id);
    expect(user).toMatchObject({ first_name: 'Ada', kyc_status: 'verified', kyc_level: 'level_1' });
    expect(user.claims.map((c) => c.claim_type)).toEqual(['kyc_verified', 'age_over_18']);

    const market = await agent.get('/market');
    expect(market.status).toBe(200);
    expect(market.text).toContain('Starter');
    expect(market.text).toContain('₦500,000');
    expect(market.text).toContain('Demo trader · Ada');
  });

  test('a person who has not started verification can browse but not trade', async () => {
    const infra = fakeInfra();
    infra.user.kyc = [];
    const agent = request.agent(createApp({ infra }));
    const state = new URL((await agent.get('/login')).headers.location).searchParams.get('state');
    await agent.get(`/callback?code=abc&state=${state}`);

    const market = await agent.get('/market');
    expect(market.text).toContain('Not verified yet');
    expect(market.text).toContain('Verify your identity in INFRA Accounts to start trading');

    const offer = db.listOffers()[0];
    await agent.post(`/offers/${offer.id}/trade`).type('form').send({ amount_usdc: '10' });
    expect(db.listTradesFor(infra.user.id)).toHaveLength(0);
  });

  test('pages need a signed-in trader', async () => {
    const res = await request(createApp({ infra: fakeInfra() })).get('/market');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?signin=1');
  });

  test('an expiring token is refreshed before use', async () => {
    const { agent, infra } = await signedIn();
    const row = db.db.prepare('SELECT sid, sess FROM sessions').get();
    const sess = JSON.parse(row.sess);
    sess.tokens.expiresAt = Date.now() - 1000;
    db.db.prepare('UPDATE sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(sess), row.sid);

    await agent.post('/refresh');
    expect(infra.calls.some((c) => c.name === 'refreshToken')).toBe(true);
    expect(infra.calls.filter((c) => c.name === 'profile').pop().args[0]).toBe('at-2');
  });
});

describe('Offers and trades', () => {
  test('a Starter trader cannot go over ₦500,000', async () => {
    const { agent, infra } = await signedIn();
    const offer = db.listOffers().find((o) => o.demo_name === 'Demo trader · Tunde'); // ₦1,608
    const res = await agent.post(`/offers/${offer.id}/trade`).type('form').send({ amount_usdc: '400' }); // ₦643,200
    expect(res.headers.location).toBe(`/offers/${offer.id}`);
    expect(db.listTradesFor(infra.user.id)).toHaveLength(0);
    const page = await agent.get(`/offers/${offer.id}`);
    expect(page.text).toContain('Your limit is ₦500,000 per trade');
  });

  test('a trade within the limit opens, carries the INFRA proof, and completes', async () => {
    const { agent, infra } = await signedIn();
    const offer = db.listOffers().find((o) => o.demo_name === 'Demo trader · Ada'); // sells at ₦1,615
    const tradeId = tradeIdFrom(await agent.post(`/offers/${offer.id}/trade`).type('form').send({ amount_usdc: '100' }));
    expect(db.getTrade(tradeId)).toMatchObject({ side: 'buy', total_ngn: 161500, status: 'open', taker_proof_hash: '0xproofhash000000000000000000000001' });

    await agent.post(`/trades/${tradeId}/paid`);
    expect(db.getTrade(tradeId).status).toBe('open'); // no money moves before verified names
    await agent.post(`/trades/${tradeId}/identity`).type('form').send({ code: 'CNX-AB12-CD34' });
    await agent.post(`/trades/${tradeId}/paid`); // the taker is buying, so pays first
    await agent.post(`/trades/${tradeId}/release`).type('form').send({ as_demo: '1' }); // demo seller releases
    expect(db.getTrade(tradeId).status).toBe('released');
    expect(db.listTradesFor(infra.user.id)).toHaveLength(1);
  });

  test("the seller cannot mark the buyer's payment", async () => {
    const { agent } = await signedIn();
    const offer = db.listOffers().find((o) => o.side === 'buy'); // demo buys, so the taker sells
    const tradeId = tradeIdFrom(await agent.post(`/offers/${offer.id}/trade`).type('form').send({ amount_usdc: '50' }));
    await agent.post(`/trades/${tradeId}/paid`);
    expect(db.getTrade(tradeId).status).toBe('open');
  });

  test('checking the trade proof asks INFRA', async () => {
    const { agent, infra } = await signedIn();
    infra.verifyClaim = jest.fn().mockResolvedValue({ ok: true, status: 200, data: { valid: false, reason: 'claim_revoked' }, body: {} });
    const offer = db.listOffers().find((o) => o.side === 'sell');
    const tradeId = tradeIdFrom(await agent.post(`/offers/${offer.id}/trade`).type('form').send({ amount_usdc: '10' }));
    await agent.post(`/trades/${tradeId}/check-proof`);
    expect(infra.verifyClaim).toHaveBeenCalledWith('0xproofhash000000000000000000000001');
    expect((await agent.get(`/trades/${tradeId}`)).text).toContain('INFRA says this proof is no longer valid (claim revoked)');
  });

  test('verified traders can post offers within their limit', async () => {
    const { agent, infra } = await signedIn();
    await agent.post('/offers').type('form').send({ side: 'sell', amount_usdc: '200', rate_ngn: '1600' });
    expect(db.listOffers().filter((o) => o.user_id === infra.user.id)).toHaveLength(1);
    await agent.post('/offers').type('form').send({ side: 'sell', amount_usdc: '1000', rate_ngn: '1600' }); // ₦1.6m
    expect(db.listOffers().filter((o) => o.user_id === infra.user.id)).toHaveLength(1);
  });

  test('another trader cannot open my trade', async () => {
    const { agent } = await signedIn();
    const offer = db.listOffers().find((o) => o.side === 'sell');
    const tradeId = tradeIdFrom(await agent.post(`/offers/${offer.id}/trade`).type('form').send({ amount_usdc: '10' }));

    const other = await signInAs('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect((await other.get(`/trades/${tradeId}`)).status).toBe(404);
  });
});

describe('Verified names on a trade (INFRA Connect)', () => {
  const openDemoTrade = async (agent) => {
    const offer = db.listOffers().find((o) => o.demo_name === 'Demo trader · Ada');
    return tradeIdFrom(await agent.post(`/offers/${offer.id}/trade`).type('form').send({ amount_usdc: '10' }));
  };

  test('you share your own code; the demo seller shows a sample; then you can pay', async () => {
    const { agent, infra } = await signedIn();
    const tradeId = await openDemoTrade(agent);
    let page = (await agent.get(`/trades/${tradeId}`)).text;
    expect(page).toContain('Verified names on this trade');
    expect(page).toContain('Ada Demo (sample)');
    expect(page).toContain('Waiting for both verified names');

    await agent.post(`/trades/${tradeId}/identity`).type('form').send({ code: 'cnx ab12 cd34' });
    const redeem = infra.calls.find((c) => c.name === 'redeemConnectCode');
    expect(redeem.args[0]).toEqual({ code: 'CNX-AB12-CD34', scopes: ['profile:basic', 'kyc:status'] });
    page = (await agent.get(`/trades/${tradeId}`)).text;
    expect(page).toContain('Ada Obi is now shown to the other trader as your verified name.');
    expect(page).not.toContain('Waiting for both verified names');

    await agent.post(`/trades/${tradeId}/paid`);
    expect(db.getTrade(tradeId).status).toBe('paid');
  });

  test("someone else's code is refused", async () => {
    const { agent, infra } = await signedIn();
    const redeem = infra.redeemConnectCode;
    infra.redeemConnectCode = async (args) => {
      const r = await redeem(args);
      return { ...r, data: { ...r.data, user_id: 'someone-else' } };
    };
    const tradeId = await openDemoTrade(agent);
    await agent.post(`/trades/${tradeId}/identity`).type('form').send({ code: 'CNX-AB12-CD34' });
    expect(db.getTrade(tradeId).taker_check_id).toBeNull();
    expect((await agent.get(`/trades/${tradeId}`)).text).toContain('That code belongs to someone else');
  });

  test('two real traders each share their own name and see the other', async () => {
    const seller = await signedIn();
    await seller.agent.post('/offers').type('form').send({ side: 'sell', amount_usdc: '100', rate_ngn: '1600' });
    const offer = db.listOffers().find((o) => o.user_id === seller.infra.user.id);

    const buyer = await signedIn();
    buyer.infra.user.id = 'bbbbbbbb-1111-2222-3333-444444444444';
    const { createApp } = require('../server/app');
    const buyerAgent = request.agent(createApp({ infra: buyer.infra }));
    const st = new URL((await buyerAgent.get('/login')).headers.location).searchParams.get('state');
    await buyerAgent.get(`/callback?code=abc&state=${st}`);

    const tradeId = tradeIdFrom(await buyerAgent.post(`/offers/${offer.id}/trade`).type('form').send({ amount_usdc: '10' }));
    expect((await seller.agent.get(`/trades/${tradeId}`)).text).toContain('Waiting for');

    await buyerAgent.post(`/trades/${tradeId}/identity`).type('form').send({ code: 'CNX-AB12-CD34' });
    await buyerAgent.post(`/trades/${tradeId}/paid`);
    expect(db.getTrade(tradeId).status).toBe('open'); // the seller hasn't shared yet

    await seller.agent.post(`/trades/${tradeId}/identity`).type('form').send({ code: 'CNX-EF56-GH78' });
    const t = db.getTrade(tradeId);
    expect(t.taker_check_id).toBeTruthy();
    expect(t.maker_check_id).toBeTruthy();
    expect((await seller.agent.get(`/trades/${tradeId}`)).text).toContain('Only release once naira arrives from an account in this name.');
    await buyerAgent.post(`/trades/${tradeId}/paid`);
    expect(db.getTrade(tradeId).status).toBe('paid');
  });

  test('a signed result is checked and the signed copy is what Kora uses', async () => {
    const { agent, infra } = await signedIn();
    const redeem = infra.redeemConnectCode;
    infra.redeemConnectCode = async (args) => {
      const r = await redeem(args);
      r.data.signed_result = 'eyJ.signed.result';
      r.data.data.profile.first_name = 'Tampered'; // plain copy differs; signed copy wins
      return r;
    };
    const tradeId = await openDemoTrade(agent);
    await agent.post(`/trades/${tradeId}/identity`).type('form').send({ code: 'CNX-AB12-CD34' });
    expect(infra.calls.find((c) => c.name === 'verifyConnectResult').args[0]).toBe('eyJ.signed.result');
    const page = (await agent.get(`/trades/${tradeId}`)).text;
    expect(page).toContain('Ada Obi');
    expect(page).not.toContain('Tampered');
    expect(page).toContain('signed by INFRA');
  });

  test('a result whose signature fails is not used', async () => {
    const { agent, infra } = await signedIn({ verifyConnectResult: async () => { throw new Error('bad signature'); } });
    const redeem = infra.redeemConnectCode;
    infra.redeemConnectCode = async (args) => ({ ...(await redeem(args)), data: { ...(await redeem(args)).data, signed_result: 'eyJ.bad' } });
    const tradeId = await openDemoTrade(agent);
    await agent.post(`/trades/${tradeId}/identity`).type('form').send({ code: 'CNX-AB12-CD34' });
    expect(db.getTrade(tradeId).taker_check_id).toBeNull();
    expect((await agent.get(`/trades/${tradeId}`)).text).toContain('signature on this result didn');
  });

  test('a bad code never reaches INFRA', async () => {
    const { agent, infra } = await signedIn();
    const tradeId = await openDemoTrade(agent);
    await agent.post(`/trades/${tradeId}/identity`).type('form').send({ code: 'hello' });
    expect(infra.calls.some((c) => c.name === 'redeemConnectCode')).toBe(false);
    expect((await agent.get(`/trades/${tradeId}`)).text).toContain('look like an INFRA Connect code');
  });

  test('INFRA errors become plain sentences', async () => {
    const { agent } = await signedIn({ redeemConnectCode: async () => fail(400, 'INVALID_CONNECT_CODE', 'Invalid or expired') });
    const tradeId = await openDemoTrade(agent);
    await agent.post(`/trades/${tradeId}/identity`).type('form').send({ code: 'CNX-AB12-CD34' });
    expect((await agent.get(`/trades/${tradeId}`)).text).toContain('Codes last 10 minutes and work once');
  });

  test('the old partner page is gone', async () => {
    const { agent } = await signedIn();
    expect((await agent.get('/check')).status).toBe(404);
  });
});

describe('Merchant badge with PayV', () => {
  const WALLET = '0x' + 'ab'.repeat(20);
  const json = (req) => req.set('Accept', 'application/json');

  async function startCheck(agent) {
    const start = await agent.post('/merchant/start').type('form').send({ code: 'CNX-WXYZ-2345' });
    return Number(start.headers.location.split('/').pop());
  }

  test('code, wallet-specific quote, signed payment, badge', async () => {
    const { agent, infra } = await signedIn();
    const id = await startCheck(agent);
    expect(infra.calls.find((c) => c.name === 'redeemConnectCode').args[0]).toMatchObject({ app: 'payv' });
    // Nothing is quoted until a wallet is connected.
    expect(infra.calls.some((c) => c.name === 'payvVerification')).toBe(false);
    expect((await agent.get(`/merchant/pay/${id}`)).text).toContain('Connect your wallet to see the price');

    const quote = await json(agent.post(`/merchant/pay/${id}/quote`)).send({ address: WALLET });
    expect(quote.body).toMatchObject({ ok: true, amount_display: '0.95', asset_symbol: 'USDC', requirements: { network: 'base-sepolia' } });
    const asked = infra.calls.find((c) => c.name === 'payvVerification').args[0];
    expect(asked).toMatchObject({ infraUserId: 'sandbox-user-1', scopes: ['profile:basic', 'kyc:status'], payerAddress: WALLET });
    expect(asked.xPayment).toBeUndefined();
    expect(db.getMerchantCheckById(id)).toMatchObject({ payment_request_id: 'pr_1', payer_address: WALLET });

    const pay = await json(agent.post(`/merchant/pay/${id}`)).send({ x_payment: 'eyJ4NDAyVmVyc2lvbiI6MX0=' });
    expect(pay.body).toEqual({ ok: true, redirect: '/merchant' });
    const paid = infra.calls.filter((c) => c.name === 'payvVerification').pop().args[0];
    expect(paid).toMatchObject({ paymentRequestId: 'pr_1', xPayment: 'eyJ4NDAyVmVyc2lvbiI6MX0=', infraUserId: 'sandbox-user-1' });
    expect(db.getMerchantCheck('pr_1')).toMatchObject({ status: 'paid', tx_hash: '0xtx1234567890abcdef', first_name: 'Sade' });

    await agent.post('/offers').type('form').send({ side: 'sell', amount_usdc: '100', rate_ngn: '1600' });
    expect(db.listOffers().find((o) => o.user_id === infra.user.id).merchant_name).toMatch(/^Sade/);
  });

  test('paying is refused until there is a quote', async () => {
    const { agent } = await signedIn();
    const id = await startCheck(agent);
    const pay = await json(agent.post(`/merchant/pay/${id}`)).send({ x_payment: 'eA==' });
    expect(pay.status).toBe(409);
  });

  test('an unlinked wallet is caught before signing, linked, then quoted', async () => {
    const { agent, infra } = await signedIn();
    const id = await startCheck(agent);
    const quoted = infra.payvVerification;
    infra.payvVerification = async () => fail(409, 'PAYER_NOT_LINKED', 'not linked', { payment_request_id: 'pr_link', payer_address: WALLET });

    const first = await json(agent.post(`/merchant/pay/${id}/quote`)).send({ address: WALLET });
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ ok: false, code: 'PAYER_NOT_LINKED' });
    expect(first.body.message).toContain('Nothing has been charged');
    expect(db.getMerchantCheckById(id)).toMatchObject({ payment_request_id: 'pr_link', requirements: null });
    // No price, so nothing can be signed or sent yet.
    expect((await json(agent.post(`/merchant/pay/${id}`)).send({ x_payment: 'eA==' })).status).toBe(409);

    const link = await json(agent.post(`/merchant/pay/${id}/wallet-link`)).send({ address: WALLET });
    expect(link.body).toEqual({ ok: true, challenge_id: 'ch_1', message: 'Link wallet to INFRA' });
    expect(infra.calls.find((c) => c.name === 'startWalletLink').args[0]).toEqual({ paymentRequestId: 'pr_link', address: WALLET });
    expect((await json(agent.get(`/merchant/pay/${id}/wallet-link/ch_1`))).body).toEqual({ ok: true, status: 'linked' });

    infra.payvVerification = quoted;
    const second = await json(agent.post(`/merchant/pay/${id}/quote`)).send({ address: WALLET });
    expect(second.body.ok).toBe(true);
    expect(db.getMerchantCheckById(id).payment_request_id).toBe('pr_1');
  });

  test('a payment from another wallet is reported, and nothing is marked paid', async () => {
    const { agent, infra } = await signedIn();
    const id = await startCheck(agent);
    await json(agent.post(`/merchant/pay/${id}/quote`)).send({ address: WALLET });
    infra.payvVerification = async () => fail(402, 'PAYER_MISMATCH', 'different wallet');
    const pay = await json(agent.post(`/merchant/pay/${id}`)).send({ x_payment: 'eA==' });
    expect(pay.status).toBe(402);
    expect(pay.body.message).toContain('Nothing was charged');
    expect(db.getMerchantCheckById(id).status).toBe('quoted');
  });

  test('verification problems stop before any price is shown', async () => {
    const { agent } = await signedIn({ payvVerification: async () => fail(403, 'VERIFICATION_REQUIRED', 'Verify first') });
    const id = await startCheck(agent);
    const res = await json(agent.post(`/merchant/pay/${id}/quote`)).send({ address: WALLET });
    expect(res.body.message).toContain('Finish verifying your identity in INFRA Accounts first');
    expect(db.getMerchantCheckById(id).payment_request_id).toBeNull();
  });

  test('another trader cannot see, quote or pay my payment request', async () => {
    const { agent } = await signedIn();
    const id = await startCheck(agent);

    const other = await signInAs('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect((await other.get(`/merchant/pay/${id}`)).status).toBe(404);
    expect((await json(other.post(`/merchant/pay/${id}/quote`)).send({ address: WALLET })).status).toBe(404);
    expect((await json(other.post(`/merchant/pay/${id}`)).send({ x_payment: 'eA==' })).status).toBe(404);
  });
});

describe('Safety', () => {
  test('a form posted from another website is refused', async () => {
    const { agent } = await signedIn();
    const res = await agent.post('/account/delete').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  test('deleting Kora data removes the trader and signs them out', async () => {
    const { agent, infra } = await signedIn();
    await agent.post('/account/delete');
    expect(db.getUser(infra.user.id)).toBeNull();
    expect((await agent.get('/market')).status).toBe(302);
  });
});

describe('Pages', () => {
  test('the landing page explains Kora and offers INFRA sign-in', async () => {
    const res = await request(createApp({ infra: fakeInfra() })).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Continue with INFRA');
  });

  test('Your details lists what INFRA shared', async () => {
    const { agent } = await signedIn();
    const res = await agent.get('/account');
    expect(res.status).toBe(200);
    expect(res.text).toContain('ada@example.com');
    expect(res.text).toContain('Over 18');
    expect(res.text).toContain('passport');
    expect(res.text).toContain('profile:read');
  });

  test('the developer panel shows setup and traffic outside production', async () => {
    const { agent } = await signedIn();
    const res = await agent.get('/dev');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/webhooks/deletion');
    expect(res.text).toContain('Calls to INFRA');
  });
});
