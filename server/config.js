require('dotenv').config();

/**
 * Everything Kora reads from the environment, in one place.
 *
 * Kora is one INFRA app: its plan covers "Sign in with INFRA" and INFRA
 * Connect, and the Pay-As-You-Verify add-on (switched on in the developer
 * portal's Billing page) pays for the merchant badge.
 *
 * PayV uses the same app. PAYV_CLIENT_ID / PAYV_CLIENT_SECRET are optional:
 * set them to the SAME app's test credentials while INFRA hasn't opened live
 * PayV payments (test credentials settle on Base Sepolia, with sandbox users);
 * leave them empty to use CLIENT_ID / CLIENT_SECRET.
 */
const env = process.env;

const config = {
  env: env.NODE_ENV || 'development',
  port: Number(env.PORT || 3002),
  dbPath: env.DB_PATH || require('path').join(__dirname, '../data/kora.db'),
  sessionSecret: env.SESSION_SECRET || 'kora-dev-only-session-secret-change-me',

  apiBase: (env.INFRA_API_BASE_URL || 'https://api.infraidentity.com').replace(/\/$/, ''),
  // "iss" on results INFRA signs (Connect results, claim credentials).
  issuer: env.INFRA_ISSUER || 'https://api.infraidentity.com',
  accountsUrl: (env.INFRA_ACCOUNTS_URL || 'https://accounts.infraidentity.com').replace(/\/$/, ''),

  oauth: {
    clientId: env.CLIENT_ID || '',
    clientSecret: env.CLIENT_SECRET || '',
    redirectUri: env.REDIRECT_URI || 'http://localhost:3002/callback',
    // The proof permissions are for "Prove it with INFRA" (one per fact; Kora tests them all).
    scopes: env.SCOPES || 'profile:read kyc:read claims:read documents:metadata offline_access proof:age_over_18 proof:age_over_21 proof:kyc_verified proof:unique_human proof:phone_verified proof:address_verified proof:watchlist_clear proof:resident_country proof:resident_state proof:postal_region',
    // Asked for too, but sign-in still works without them: if Kora's app on
    // INFRA doesn't allow one yet, Kora signs in again without it.
    optionalScopes: env.OPTIONAL_SCOPES ?? 'phone:read',
    authUrl: env.HYDRA_AUTH_URL || 'https://oauth.infraidentity.com/oauth2/auth',
    tokenUrl: env.HYDRA_TOKEN_URL || 'https://oauth.infraidentity.com/oauth2/token',
  },

  payv: {
    clientId: env.PAYV_CLIENT_ID || env.CLIENT_ID || '',
    clientSecret: env.PAYV_CLIENT_ID ? (env.PAYV_CLIENT_SECRET || '') : (env.CLIENT_SECRET || ''),
  },

  // Signs both webhooks and deletion callbacks (INFRA uses the app's webhook
  // secret for both).
  webhookSecret: env.WEBHOOK_SECRET || '',

  // Opens /dev (API calls and webhooks). Without it, /dev only works locally.
  devPanelKey: env.DEV_PANEL_KEY || '',
};

config.isProduction = config.env === 'production';

// The dev fallback is public (it's in this file): anyone could sign session
// cookies with it. A deployed Kora must set its own.
if (config.isProduction && !env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production');
}

module.exports = config;
