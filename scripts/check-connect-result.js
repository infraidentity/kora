#!/usr/bin/env node
/**
 * Check an INFRA Connect result (signed_result) yourself, with INFRA's public
 * key. Same code Kora runs (server/infra/credential.js).
 *
 *   node scripts/check-connect-result.js <signed result>
 *   node scripts/check-connect-result.js path/to/result.txt
 *   node scripts/check-connect-result.js -
 *
 * Options (defaults from .env): --client-id <id>  --issuer <url>  --api <url>
 *
 * Where to get one: Kora's developer panel (/dev → Signed by INFRA → Latest
 * Connect result), or `signed_result` from POST /api/v1/connect/request.
 * Exit code 0 when it checks out, 1 when it doesn't.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const { checkConnectResult } = require('../server/infra/credential');

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

(async () => {
  const x = positional[0];
  const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  const token = (x === '-' ? fs.readFileSync(0, 'utf8') : x && isFile(x) ? fs.readFileSync(x, 'utf8') : x || '').trim();
  if (!token) {
    console.error('Usage: node scripts/check-connect-result.js <signed result | file | -> [--client-id ID] [--issuer URL] [--api URL]');
    process.exit(2);
  }
  const apiBase = (opt('api') || process.env.INFRA_API_BASE_URL || 'https://api.infraidentity.com').replace(/\/$/, '');
  const audience = opt('client-id') || process.env.CLIENT_ID || undefined;
  const issuer = opt('issuer') || process.env.INFRA_ISSUER || undefined;

  console.log(`Public keys: ${apiBase}/.well-known/jwks.json`);
  console.log(`Must be issued to: ${audience || '(any app: pass --client-id to check)'}\n`);

  const r = await checkConnectResult(token, { apiBase, audience, issuer });
  for (const s of r.steps) console.log(`${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? `  (${s.detail})` : ''}`);
  console.log('');
  if (!r.ok) {
    console.log(`NOT VALID: ${r.reason}`);
    process.exit(1);
  }
  const p = r.data.profile || {};
  const k = r.data.kyc || {};
  console.log(`VALID: signed by INFRA (key ${r.kid}).`);
  console.log(`Person (this app's id for them): ${r.subject}   request: ${r.requestId}`);
  console.log(`Shared: ${[p.first_name, p.last_name].filter(Boolean).join(' ') || '(no name)'}${p.country ? ', ' + p.country : ''} · ${k.status || 'unknown'}${k.kyc_level ? ' ' + k.kyc_level : ''}`);
})().catch((err) => {
  console.error(`Could not check it: ${err.message}`);
  process.exit(1);
});
