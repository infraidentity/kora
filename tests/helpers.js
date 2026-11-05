const request = require('supertest');
const { createApp } = require('../server/app');
const { fakeInfra } = require('./fake-infra');

/** An app with a fake INFRA and a browser-like agent already signed in. */
async function signedIn(overrides) {
  const infra = fakeInfra(overrides);
  const app = createApp({ infra });
  const agent = request.agent(app);
  const login = await agent.get('/login');
  const state = new URL(login.headers.location).searchParams.get('state');
  const res = await agent.get(`/callback?code=abc&state=${state}`);
  if (res.status !== 302 || res.headers.location !== '/market') {
    throw new Error(`sign-in failed: ${res.status} ${res.text.slice(0, 300)}`);
  }
  return { app, agent, infra };
}

module.exports = { signedIn };
