#!/usr/bin/env node
/**
 * Check an INFRA verified facts credential yourself, with INFRA's public key.
 * It runs the same code Kora runs (server/infra/credential.js).
 *
 *   node scripts/check-credential.js <credential>
 *   node scripts/check-credential.js path/to/credential.txt
 *   node scripts/check-credential.js -            (paste it, then Ctrl+D / Ctrl+Z Enter)
 *
 * Options (defaults come from .env, the same settings Kora uses):
 *   --client-id <id>     your app's client id; the credential must be issued to it (CLIENT_ID)
 *   --issuer <url>       who must have issued it (INFRA_ISSUER)
 *   --api <url>          where INFRA's public keys are (INFRA_API_BASE_URL)
 *   --live               refuse test-user credentials (for live verified accounts)
 *   --test               refuse live credentials
 *
 * Where to get a credential: Kora's developer panel (/dev → Signed by INFRA),
 * or the `credential` field of GET /api/v1/users/{id}/claims.
 * Exit code 0 when it checks out, 1 when it doesn't.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const { checkCredential } = require('../server/infra/credential');

function args(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') out.expect = 'live';
    else if (a === '--test') out.expect = 'test';
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out.positional.push(a);
  }
  return out;
}

function readInput(x) {
  if (!x) return null;
  if (x === '-') return fs.readFileSync(0, 'utf8');
  try { if (fs.statSync(x).isFile()) return fs.readFileSync(x, 'utf8'); } catch { /* not a file: the credential itself */ }
  return x;
}

(async () => {
  const a = args(process.argv.slice(2));
  const credential = (readInput(a.positional[0]) || '').trim();
  if (!credential) {
    console.error('Usage: node scripts/check-credential.js <credential | file | -> [--live] [--client-id ID] [--issuer URL] [--api URL]');
    process.exit(2);
  }
  const apiBase = (a.api || process.env.INFRA_API_BASE_URL || 'https://api.infraidentity.com').replace(/\/$/, '');
  const audience = a['client-id'] || process.env.CLIENT_ID || undefined;
  const issuer = a.issuer || process.env.INFRA_ISSUER || undefined;

  console.log(`Public keys: ${apiBase}/.well-known/jwks.json`);
  console.log(`Must be issued to: ${audience || '(any app: pass --client-id to check)'}`);
  console.log(`Must be issued by: ${issuer || '(not checked: pass --issuer)'}`);
  if (a.expect) console.log(`Must be for a ${a.expect} account`);
  console.log('');

  const r = await checkCredential(credential, { apiBase, audience, issuer, expectEnvironment: a.expect });
  for (const s of r.steps) console.log(`${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? `  (${s.detail})` : ''}`);
  console.log('');

  if (!r.ok) {
    console.log(`NOT VALID: ${r.reason}`);
    process.exit(1);
  }
  console.log(`VALID: signed by INFRA (key ${r.kid}), ${r.environment} account.`);
  console.log(`Person (this app's id for them): ${r.subject}`);
  console.log(`Issued ${r.issuedAt}, expires ${r.expiresAt}`);
  console.log('Signed facts:');
  for (const f of r.facts) {
    const { name, value, provider, issued_at: issuedAt, expires_at: expiresAt } = f;
    console.log(`  • ${name}${value ? ' = ' + JSON.stringify(value) : ''}  (by ${provider || 'infra'}, since ${issuedAt || '?'}${expiresAt ? ', until ' + expiresAt : ''})`);
  }
})().catch((err) => {
  console.error(`Could not check it: ${err.message}`);
  process.exit(1);
});
