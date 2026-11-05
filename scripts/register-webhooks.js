/**
 * Subscribe Kora's main app to every INFRA webhook event.
 *
 *   node scripts/register-webhooks.js <developer_access_token>
 *
 * The token is your developer-portal session token. KORA_PUBLIC_URL must be a
 * public https URL (INFRA refuses localhost); use your Railway URL or a tunnel.
 * The secret is WEBHOOK_SECRET from .env, so Kora can check signatures.
 */
require('dotenv').config();
const axios = require('axios');

const API = (process.env.INFRA_API_BASE_URL || 'http://localhost:3100').replace(/\/$/, '');
const PUBLIC_URL = (process.env.KORA_PUBLIC_URL || '').replace(/\/$/, '');
const SECRET = process.env.WEBHOOK_SECRET;
const TOKEN = process.argv[2];

const EVENTS = [
  'consent_granted', 'consent_revoked',
  'kyc_verified', 'kyc_rejected', 'kyc_status_updated',
  'claim_issued', 'claim_revoked',
  'user_deleted',
];

async function main() {
  if (!TOKEN) throw new Error('Usage: node scripts/register-webhooks.js <developer_access_token>');
  if (!SECRET) throw new Error('Set WEBHOOK_SECRET in .env first.');
  if (!PUBLIC_URL.startsWith('https://')) throw new Error('Set KORA_PUBLIC_URL to Kora\'s public https URL.');

  const headers = { Authorization: `Bearer ${TOKEN}` };
  const res = await axios.post(`${API}/api/v1/developer/webhooks`, {
    webhookUrl: `${PUBLIC_URL}/webhooks/infra`,
    secret: SECRET,
    eventTypes: EVENTS,
  }, { headers });
  const hook = res.data.data?.webhook || res.data.webhook;
  console.log(`Subscribed ${hook.webhookUrl} to ${hook.eventTypes.join(', ')}`);
  console.log(`Also set the app's deletion callback URL to ${PUBLIC_URL}/webhooks/deletion in the developer portal.`);
}

main().catch((err) => {
  console.error(err.response?.data?.error?.message || err.message);
  process.exit(1);
});
