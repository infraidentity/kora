# Kora: an example app built on INFRA

> **Demo app. No real naira or USDC is traded.** Kora exists to show how an
> app uses [INFRA](https://infraidentity.com) for sign-in, verified details,
> proofs, live updates and data deletion. Copy whatever helps you.

## Start here

### 1. Try it live (2 minutes, nothing to install)

1. Open **https://korra-peer-app.up.railway.app**.
2. Tap **Continue with INFRA** and create an INFRA account (free).
3. Verify your identity when INFRA asks. INFRA is in testing, so the ID check
   runs in test mode: don't use a real ID, use the test options shown on
   screen.
4. Watch Kora react by itself: your trading limit goes up, your verified name
   shows on trades, and each trade gets an INFRA proof.
5. To see your data deleted, remove Kora in INFRA Accounts → Connected apps.
   Kora deletes what it holds about you and signs you out.

### 2. Run your own copy (about 15 minutes)

1. Create an app in the [INFRA developer portal](https://developers.infraidentity.com)
   and copy its **test** keys.
2. On your app's page, switch to **Test** and press **Create test user**. Test keys
   only accept test users, and test users never cost anything.
3. `npm install`, `cp .env.example .env`, put your keys in `.env`, then
   `npm run dev` and open http://localhost:3002.
4. Optional: INFRA can't send live updates to your own computer. Use a tunnel
   (or deploy Kora) and follow [Setup](#setup) to register them.

Full steps are in [Setup](#setup) below.

### 3. Copy the parts you need

| I want to… | Look at |
|---|---|
| Add "Continue with INFRA" sign-in | `server/routes/auth.js`, `server/utils/pkce.js` |
| Read a person's verified details | `server/infra/client.js` |
| Set limits by verification level | `server/services/identity.js` |
| Check that INFRA really signed something | `server/infra/credential.js`, `scripts/check-credential.js` |
| React when someone is verified or withdraws access | `server/routes/webhooks.js`, `server/infra/signatures.js` |
| Delete a person's data when INFRA tells you to | `server/routes/webhooks.js` (deletion callback) |
| Show verified names before money moves (INFRA Connect) | `server/services/trade-identity.js`, `server/routes/market.js` |
| Charge per check (Pay-As-You-Verify) | `server/routes/merchant.js`, `client/public/payv.js` |

Everything else: [docs.infraidentity.com](https://docs.infraidentity.com).
Questions or problems: open an issue on this repo.

## What Kora shows

Kora is a peer-to-peer marketplace where people buy and sell USDC for naira.
Strangers swapping money is exactly where identity matters, so Kora uses
INFRA for everything that touches identity, and in doing so exercises every
part of INFRA's API.

| In Kora | INFRA API |
|---|---|
| **Continue with INFRA** (OAuth 2.0 + PKCE, refresh tokens) | `/oauth2/auth`, `/oauth2/token`, `GET /users/me` |
| **Trading limits** follow verification: Browse → Starter (₦500k) → Full (₦5m) | `GET /users/:id/kyc`, `GET /users/:id/claims` |
| **Your details**: everything INFRA shared, and how to withdraw it | `GET /users/:id/profile`, `GET /users/:id/documents/metadata` |
| **Verified names on every trade**: before money moves, each trader shares their own INFRA Connect code on the trade and the other side sees their verified full name (demo traders show a sample); the result's signature is checked against INFRA's public keys | `POST /connect/request`, `/.well-known/jwks.json` |
| **INFRA proof** stamped on every trade, checkable later | `POST /claims/verify` |
| **Merchant badge**: the merchant pays a USDC fee from their wallet for Kora to reuse their verification | `POST /payv/verification` (402 → X-PAYMENT), `/payv/wallet-links` |
| **Live updates**: limits change the moment INFRA verifies someone; withdrawn access deletes their data and signs them out | webhooks (all 9 events), deletion callback, `POST /deletion/acknowledge` |
| **Developer panel** at `/dev`: every call to INFRA and every webhook, with signature results | — |

Trades are simulated (no naira or USDC changes hands in a trade). Four demo
traders are always online so one person can test a full trade.

## One INFRA app

Kora is a single INFRA app. Its plan covers sign-in, Connect checks, webhooks
and deletion callbacks; the Pay-As-You-Verify add-on pays for the merchant
badge. The badge's Connect request is sent with `billing: "payv"`, so it
records the merchant's consent without counting toward the plan.

## Setup

1. `npm install`, then `cp .env.example .env`.
2. In the INFRA developer portal, create **Kora**:
   - Redirect URI: `http://localhost:3002/callback` (or your Railway URL + `/callback`)
   - Scopes: `profile:read kyc:read claims:read documents:metadata`
   - Deletion callback URL: `<public url>/webhooks/deletion`
   - Put its client id and secret in `CLIENT_ID` / `CLIENT_SECRET`.
3. On the portal's **Billing** page, turn on **Pay-As-You-Verify** for the
   same app (the merchant badge uses it). Leave `PAYV_CLIENT_ID` /
   `PAYV_CLIENT_SECRET` empty to use `CLIENT_ID` / `CLIENT_SECRET`. Until
   INFRA opens live PayV payments, every payment settles on Base Sepolia
   with test USDC, whichever keys you use. Optional: turn on strict payer
   mode (`payer_must_be_user`) to test wallet linking.
4. Pick a `WEBHOOK_SECRET`, set `KORA_PUBLIC_URL`, and run
   `node scripts/register-webhooks.js <developer token>`. INFRA won't send
   webhooks to localhost; use the Railway deployment or a tunnel.
5. `npm run dev` and open http://localhost:3002. Check `/dev`: it shows what
   is configured and the exact URLs to register.

## Trying each feature

- **Limits**: sign in with an unverified account → Browse. Verify in INFRA
  Accounts; the market page switches to Starter on its own when the
  `kyc_verified` webhook arrives.
- **Verified names on a trade**: take a demo offer, then in INFRA Accounts tap
  **Connect an app** and paste your code into the trade; the demo seller shows
  a sample identity. For the full two-person exchange, sign in as a second
  test user in another browser: one posts an offer, the other takes it, and
  both share their codes on the trade.
- **Signed by INFRA**: Your details shows whether the facts INFRA shared
  check out against INFRA's public key. Check them yourself (from this
  folder; settings come from `.env`):

  ```bash
  # copy the credential from /dev → "Signed by INFRA"
  npm run check:credential -- "<credential>" --live      # refuse test users
  npm run check:connect -- "<signed result>"
  ```

  Each prints every step (signed by INFRA, issued to this app, not expired,
  live or test, every fact signed) and ends with VALID or NOT VALID.
- **Merchant badge**: needs a verified INFRA account (a sandbox user if Kora
  runs on test keys), a wallet such as MetaMask with test USDC on Base Sepolia
  (free from faucet.circle.com), and a Connect code from that account. Until
  INFRA opens live payments, the fee is paid in test USDC: no real money.
  Kora quotes the fee (402), your wallet signs an EIP-3009 authorization
  (`client/public/payv.js`, no gas), and Kora retries with `X-PAYMENT`.
- **Deletion**: remove Kora in INFRA Accounts → Connected apps. The
  `consent_revoked` webhook deletes the trader and ends their session.

## Tests

`npm test` runs the suite against a fake INFRA (`tests/fake-infra.js`):
sign-in and PKCE, token refresh, limits, trades, Connect, proof checks, the
PayV 402 → pay → wallet-link loop, webhook signatures (canonical JSON),
deletion callbacks (plain JSON), de-duplication, and cross-user access.

## Layout

```
server/
  app.js              Express app (createApp takes the INFRA client, for tests)
  config.js           every environment variable
  db.js               SQLite schema and queries
  infra/client.js     every call to INFRA, logged for /dev
  infra/signatures.js webhook + deletion signature checks
  services/           limits (identity.js), plain error messages, session helpers
  routes/             auth, market, check (Connect), merchant (PayV), webhooks, account + /dev
client/views          pages (EJS)
client/public         kora.css, payv.js (wallet signing)
scripts/              register-webhooks.js
```
