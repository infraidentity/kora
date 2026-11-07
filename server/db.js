const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

/**
 * Kora's own database. It keeps only what Kora needs to run a marketplace:
 * the INFRA facts each trader shared (name, country, verification), offers,
 * trades, and logs of what INFRA sent us. Everything about a person is
 * deleted when INFRA tells us they revoked access or asked for deletion.
 */
if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,               -- the INFRA user id
    email TEXT,
    first_name TEXT,
    last_name TEXT,
    country TEXT,
    username TEXT,
    profile_url TEXT,
    kyc_level TEXT,
    kyc_status TEXT NOT NULL DEFAULT 'not_started',
    kyc_provider TEXT,
    verified_at TEXT,
    claims_json TEXT NOT NULL DEFAULT '[]',
    documents_json TEXT NOT NULL DEFAULT '[]',
    synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    user_id TEXT,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,  -- NULL for demo traders
    demo_name TEXT,
    side TEXT NOT NULL CHECK (side IN ('sell', 'buy')),   -- what the poster does with USDC
    amount_usdc REAL NOT NULL,
    rate_usd REAL NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    taker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    side TEXT NOT NULL,              -- what the taker does with USDC
    amount_usdc REAL NOT NULL,
    rate_usd REAL NOT NULL,
    total_usd REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'released', 'cancelled')),
    taker_proof_hash TEXT,           -- the taker's kyc_verified claim when the trade opened
    partner_check_id INTEGER REFERENCES partner_checks(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS partner_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checked_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id TEXT,
    infra_user_id TEXT,
    first_name TEXT,
    last_name TEXT,
    country TEXT,
    username TEXT,
    kyc_level TEXT,
    kyc_status TEXT,
    verified_at TEXT,
    signed INTEGER NOT NULL DEFAULT 0,  -- 1 when INFRA's signed_result verified
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS merchant_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,  -- signed-in Kora user who started it
    infra_user_id TEXT NOT NULL,
    payment_request_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'quoted' CHECK (status IN ('quoted', 'paid', 'failed')),
    amount_display TEXT,
    asset_symbol TEXT,
    requirements_json TEXT,
    payer_requirement TEXT,
    payer_address TEXT,              -- the wallet the current quote is bound to
    tx_hash TEXT,
    first_name TEXT,
    last_name TEXT,
    country TEXT,
    kyc_level TEXT,
    verified_at TEXT,
    failure TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT UNIQUE,           -- event_id, or deletion_request_id for deletion callbacks
    event_type TEXT,
    kind TEXT NOT NULL,              -- 'webhook' | 'deletion'
    signature_ok INTEGER NOT NULL,
    payload TEXT,
    outcome TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app TEXT NOT NULL,               -- 'main' | 'payv' | 'oauth'
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER,
    code TEXT,
    ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Columns added after the first release, for databases created before them.
// Kora used to trade against naira (rate_ngn, total_ngn). It now uses US
// dollars. An older database is converted once, in place: prices and totals
// are divided by the old demo rate (1,600 naira to the dollar) so past trades
// keep their meaning, and the demo traders get their new names and prices.
{
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (has('offers', 'rate_ngn')) {
    db.transaction(() => {
      db.exec('ALTER TABLE offers RENAME COLUMN rate_ngn TO rate_usd');
      db.exec('ALTER TABLE trades RENAME COLUMN rate_ngn TO rate_usd');
      db.exec('ALTER TABLE trades RENAME COLUMN total_ngn TO total_usd');
      db.exec('UPDATE offers SET rate_usd = rate_usd / 1600.0 WHERE user_id IS NOT NULL');
      db.exec('UPDATE trades SET rate_usd = rate_usd / 1600.0, total_usd = total_usd / 1600.0');
      const demo = db.prepare('UPDATE offers SET demo_name = ?, rate_usd = ? WHERE demo_name = ?');
      demo.run('Demo trader · Lena', 1.004, 'Demo trader · Ada');
      demo.run('Demo trader · Mateo', 1.002, 'Demo trader · Tunde');
      demo.run('Demo trader · Priya', 0.996, 'Demo trader · Ngozi');
      demo.run('Demo trader · Kenji', 0.998, 'Demo trader · Musa');
    })();
  }
}

try { db.exec('ALTER TABLE partner_checks ADD COLUMN signed INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
try { db.exec('ALTER TABLE merchant_checks ADD COLUMN payer_address TEXT'); } catch { /* already there */ }
// What INFRA's events told Kora about a person (newest first), and the
// standing warnings they set (ID expiring, address out of date...).
try { db.exec("ALTER TABLE users ADD COLUMN alerts_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* already there */ }
// Each side's own verified identity on a trade (shared with an INFRA Connect code).
try { db.exec('ALTER TABLE trades ADD COLUMN taker_check_id INTEGER REFERENCES partner_checks(id) ON DELETE SET NULL'); } catch { /* already there */ }
try { db.exec('ALTER TABLE trades ADD COLUMN maker_check_id INTEGER REFERENCES partner_checks(id) ON DELETE SET NULL'); } catch { /* already there */ }
try { db.exec("ALTER TABLE users ADD COLUMN flags_json TEXT NOT NULL DEFAULT '{}'"); } catch { /* already there */ }
// INFRA's signed credential for the person's facts, and Kora's check of it.
try { db.exec('ALTER TABLE users ADD COLUMN credential TEXT'); } catch { /* already there */ }
try { db.exec('ALTER TABLE users ADD COLUMN credential_check_json TEXT'); } catch { /* already there */ }
try { db.exec('ALTER TABLE partner_checks ADD COLUMN signed_result TEXT'); } catch { /* already there */ }
// The phone number the person shared (phone:read) and whether INFRA confirmed it.
try { db.exec('ALTER TABLE users ADD COLUMN phone_json TEXT'); } catch { /* already there */ }

const json = (value, fallback) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

// ── Users ────────────────────────────────────────────────────────────────────

function getUser(id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    claims: json(row.claims_json, []),
    documents: json(row.documents_json, []),
    alerts: json(row.alerts_json, []),
    flags: json(row.flags_json, {}),
    credentialCheck: json(row.credential_check_json, null),
    phone: json(row.phone_json, null),
  };
}

const MAX_ALERTS = 20;

/** Note what an INFRA event meant for this person (shown on their pages). */
function addAlert(id, { tone = 'info', text, eventType, simulated = false }) {
  const row = db.prepare('SELECT alerts_json FROM users WHERE id = ?').get(id);
  if (!row) return false;
  const alerts = json(row.alerts_json, []);
  alerts.unshift({ tone, text, event_type: eventType || null, simulated: Boolean(simulated), at: new Date().toISOString() });
  db.prepare('UPDATE users SET alerts_json = ? WHERE id = ?').run(JSON.stringify(alerts.slice(0, MAX_ALERTS)), id);
  return true;
}

/** Merge standing warnings; a key set to null is cleared. */
function setFlags(id, changes) {
  const row = db.prepare('SELECT flags_json FROM users WHERE id = ?').get(id);
  if (!row) return false;
  const flags = json(row.flags_json, {});
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined) delete flags[k];
    else flags[k] = v;
  }
  db.prepare('UPDATE users SET flags_json = ? WHERE id = ?').run(JSON.stringify(flags), id);
  return true;
}

function saveUser(user) {
  db.prepare(`
    INSERT INTO users (id, email, first_name, last_name, country, username, profile_url,
                       kyc_level, kyc_status, kyc_provider, verified_at, claims_json, documents_json,
                       credential, credential_check_json, phone_json, synced_at)
    VALUES (@id, @email, @first_name, @last_name, @country, @username, @profile_url,
            @kyc_level, @kyc_status, @kyc_provider, @verified_at, @claims_json, @documents_json,
            @credential, @credential_check_json, @phone_json, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email, first_name = excluded.first_name, last_name = excluded.last_name,
      country = excluded.country, username = excluded.username, profile_url = excluded.profile_url,
      kyc_level = excluded.kyc_level, kyc_status = excluded.kyc_status, kyc_provider = excluded.kyc_provider,
      verified_at = excluded.verified_at, claims_json = excluded.claims_json,
      documents_json = excluded.documents_json, credential = excluded.credential,
      credential_check_json = excluded.credential_check_json, phone_json = excluded.phone_json,
      synced_at = datetime('now')
  `).run({
    id: user.id,
    email: user.email ?? null,
    first_name: user.first_name ?? null,
    last_name: user.last_name ?? null,
    country: user.country ?? null,
    username: user.username ?? null,
    profile_url: user.profile_url ?? null,
    kyc_level: user.kyc_level ?? null,
    kyc_status: user.kyc_status || 'not_started',
    kyc_provider: user.kyc_provider ?? null,
    verified_at: user.verified_at ?? null,
    claims_json: JSON.stringify(user.claims || []),
    documents_json: JSON.stringify(user.documents || []),
    credential: user.credential ?? null,
    credential_check_json: user.credential_check ? JSON.stringify(user.credential_check) : null,
    phone_json: user.phone ? JSON.stringify(user.phone) : null,
  });
}

/** The phone number from INFRA's "access allowed" notice (null removes it). */
function setPhone(userId, phone) {
  db.prepare('UPDATE users SET phone_json = ? WHERE id = ?').run(phone ? JSON.stringify(phone) : null, userId);
}

function updateVerification(id, { kyc_level, kyc_status, verified_at }) {
  return db.prepare(`
    UPDATE users SET kyc_level = COALESCE(@kyc_level, kyc_level), kyc_status = @kyc_status,
           verified_at = COALESCE(@verified_at, verified_at)
    WHERE id = @id
  `).run({ id, kyc_level: kyc_level ?? null, kyc_status, verified_at: verified_at ?? null }).changes > 0;
}

function setLevel(id, kyc_level) {
  return db.prepare('UPDATE users SET kyc_level = ? WHERE id = ?').run(kyc_level, id).changes > 0;
}

function setClaims(id, claims) {
  return db.prepare('UPDATE users SET claims_json = ? WHERE id = ?').run(JSON.stringify(claims), id).changes > 0;
}

/**
 * Forget a person completely: their profile, offers, trades, checks they ran,
 * sessions, and any check other traders ran on them. Returns true if Kora
 * held anything.
 */
const forgetUser = db.transaction((id) => {
  let changes = 0;
  changes += db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id).changes;
  changes += db.prepare('DELETE FROM partner_checks WHERE infra_user_id = ?').run(id).changes;
  changes += db.prepare(`
    UPDATE merchant_checks SET first_name = NULL, last_name = NULL, country = NULL, infra_user_id = 'deleted'
    WHERE infra_user_id = ?
  `).run(id).changes;
  changes += db.prepare('DELETE FROM users WHERE id = ?').run(id).changes; // cascades offers, trades, checks
  return changes > 0;
});

// ── Offers and trades ────────────────────────────────────────────────────────

function listOffers() {
  return db.prepare(`
    SELECT o.*, u.first_name, u.last_name, u.username, u.kyc_status, u.kyc_level, u.verified_at, u.country,
           (SELECT m.first_name || ' ' || COALESCE(m.last_name, '') FROM merchant_checks m
             WHERE m.owner_id = o.user_id AND m.status = 'paid' ORDER BY m.id DESC LIMIT 1) AS merchant_name
    FROM offers o LEFT JOIN users u ON u.id = o.user_id
    WHERE o.active = 1
    ORDER BY o.created_at DESC, o.id DESC
  `).all();
}

function getOffer(id) {
  return db.prepare(`
    SELECT o.*, u.first_name, u.last_name, u.username, u.kyc_status, u.kyc_level, u.verified_at, u.country
    FROM offers o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?
  `).get(id);
}

function createOffer({ userId, side, amountUsdc, rateUsd }) {
  return db.prepare('INSERT INTO offers (user_id, side, amount_usdc, rate_usd) VALUES (?, ?, ?, ?)')
    .run(userId, side, amountUsdc, rateUsd).lastInsertRowid;
}

function closeOffer(id, userId) {
  return db.prepare('UPDATE offers SET active = 0 WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

function seedDemoOffers() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM offers WHERE user_id IS NULL').get().n;
  if (count > 0) return;
  const insert = db.prepare('INSERT INTO offers (demo_name, side, amount_usdc, rate_usd) VALUES (?, ?, ?, ?)');
  insert.run('Demo trader · Lena', 'sell', 500, 1.004);
  insert.run('Demo trader · Mateo', 'sell', 2500, 1.002);
  insert.run('Demo trader · Priya', 'buy', 1200, 0.996);
  insert.run('Demo trader · Kenji', 'buy', 300, 0.998);
}

function createTrade(trade) {
  return db.prepare(`
    INSERT INTO trades (offer_id, taker_id, side, amount_usdc, rate_usd, total_usd, taker_proof_hash)
    VALUES (@offerId, @takerId, @side, @amountUsdc, @rateUsd, @totalUsd, @takerProofHash)
  `).run(trade).lastInsertRowid;
}

function getTrade(id) {
  return db.prepare(`
    SELECT t.*, o.user_id AS maker_id, o.demo_name, o.side AS offer_side,
           mu.first_name AS maker_first_name, mu.last_name AS maker_last_name, mu.kyc_status AS maker_kyc_status,
           tu.first_name AS taker_first_name, tu.last_name AS taker_last_name, tu.kyc_level AS taker_kyc_level,
           pc.first_name AS partner_first_name, pc.last_name AS partner_last_name, pc.kyc_level AS partner_kyc_level,
           pc.kyc_status AS partner_kyc_status, pc.country AS partner_country, pc.created_at AS partner_checked_at,
           pc.signed AS partner_signed,
           tc.first_name AS taker_v_first_name, tc.last_name AS taker_v_last_name, tc.kyc_status AS taker_v_kyc_status,
           tc.kyc_level AS taker_v_kyc_level, tc.country AS taker_v_country, tc.signed AS taker_v_signed,
           mc.first_name AS maker_v_first_name, mc.last_name AS maker_v_last_name, mc.kyc_status AS maker_v_kyc_status,
           mc.kyc_level AS maker_v_kyc_level, mc.country AS maker_v_country, mc.signed AS maker_v_signed
    FROM trades t
    JOIN offers o ON o.id = t.offer_id
    LEFT JOIN users mu ON mu.id = o.user_id
    LEFT JOIN users tu ON tu.id = t.taker_id
    LEFT JOIN partner_checks pc ON pc.id = t.partner_check_id
    LEFT JOIN partner_checks tc ON tc.id = t.taker_check_id
    LEFT JOIN partner_checks mc ON mc.id = t.maker_check_id
    WHERE t.id = ?
  `).get(id);
}

function listTradesFor(userId) {
  return db.prepare(`
    SELECT t.*, o.demo_name, o.user_id AS maker_id, mu.first_name AS maker_first_name
    FROM trades t JOIN offers o ON o.id = t.offer_id LEFT JOIN users mu ON mu.id = o.user_id
    WHERE t.taker_id = ? OR o.user_id = ?
    ORDER BY t.id DESC LIMIT 20
  `).all(userId, userId);
}

function setTradeStatus(id, status) {
  db.prepare("UPDATE trades SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

/** Stamp one side's own verified identity on a trade ('taker' or 'maker'). */
function attachIdentity(tradeId, side, checkId) {
  const column = side === 'maker' ? 'maker_check_id' : 'taker_check_id';
  db.prepare(`UPDATE trades SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`).run(checkId, tradeId);
}

function attachPartnerCheck(tradeId, checkId) {
  db.prepare("UPDATE trades SET partner_check_id = ?, updated_at = datetime('now') WHERE id = ?").run(checkId, tradeId);
}

// ── INFRA Connect partner checks ─────────────────────────────────────────────

function savePartnerCheck(check) {
  return db.prepare(`
    INSERT INTO partner_checks (checked_by, request_id, infra_user_id, first_name, last_name, country,
                                username, kyc_level, kyc_status, verified_at, signed, signed_result)
    VALUES (@checkedBy, @requestId, @infraUserId, @firstName, @lastName, @country,
            @username, @kycLevel, @kycStatus, @verifiedAt, @signed, @signedResult)
  `).run({ signedResult: null, ...check }).lastInsertRowid;
}

/** The signed things INFRA gave Kora about this person (dev panel). */
function latestSignedItems(userId) {
  const u = db.prepare('SELECT credential, credential_check_json FROM users WHERE id = ?').get(userId) || {};
  const c = db.prepare('SELECT signed_result, created_at FROM partner_checks WHERE checked_by = ? AND signed_result IS NOT NULL ORDER BY id DESC LIMIT 1').get(userId) || {};
  return {
    credential: u.credential || null,
    credentialCheck: json(u.credential_check_json, null),
    connectResult: c.signed_result || null,
    connectAt: c.created_at || null,
  };
}

function listPartnerChecks(userId) {
  return db.prepare('SELECT * FROM partner_checks WHERE checked_by = ? ORDER BY id DESC LIMIT 10').all(userId);
}

// ── PayV merchant checks ─────────────────────────────────────────────────────

/** A merchant shared their verification with Kora for the badge; no quote yet. */
function startMerchantCheck({ ownerId, infraUserId }) {
  return db.prepare('INSERT INTO merchant_checks (owner_id, infra_user_id) VALUES (?, ?)').run(ownerId, infraUserId).lastInsertRowid;
}

/**
 * Record INFRA's answer to a quote request for one wallet. requirements is
 * null when INFRA refused to quote (wallet not linked yet): the
 * payment_request_id is still kept, because wallet linking runs against it.
 */
function setMerchantQuote(id, q) {
  db.prepare(`
    UPDATE merchant_checks SET payment_request_id = @paymentRequestId, payer_address = @payerAddress,
           amount_display = @amountDisplay, asset_symbol = @assetSymbol, requirements_json = @requirementsJson,
           payer_requirement = @payerRequirement, failure = NULL, updated_at = datetime('now')
    WHERE id = @id AND status <> 'paid'
  `).run({ id, ...q });
}

const withRequirements = (row) => (row ? { ...row, requirements: json(row.requirements_json, null) } : null);

function getMerchantCheckById(id) {
  return withRequirements(db.prepare('SELECT * FROM merchant_checks WHERE id = ?').get(id));
}

function getMerchantCheck(paymentRequestId) {
  return withRequirements(db.prepare('SELECT * FROM merchant_checks WHERE payment_request_id = ?').get(paymentRequestId));
}

function completeMerchantCheck(paymentRequestId, r) {
  db.prepare(`
    UPDATE merchant_checks SET status = 'paid', tx_hash = @txHash, first_name = @firstName, last_name = @lastName,
           country = @country, kyc_level = @kycLevel, verified_at = @verifiedAt, failure = NULL,
           updated_at = datetime('now')
    WHERE payment_request_id = @paymentRequestId
  `).run({ paymentRequestId, ...r });
}

function failMerchantCheck(paymentRequestId, failure) {
  db.prepare(`
    UPDATE merchant_checks SET failure = ?, updated_at = datetime('now')
    WHERE payment_request_id = ? AND status <> 'paid'
  `).run(failure, paymentRequestId);
}

function listMerchantChecks(ownerId) {
  return db.prepare('SELECT * FROM merchant_checks WHERE owner_id = ? ORDER BY id DESC LIMIT 10').all(ownerId);
}

// ── Logs ─────────────────────────────────────────────────────────────────────

/** Records a webhook; returns false if this event was already handled. */
function recordWebhook({ eventKey, eventType, kind, signatureOk, payload }) {
  try {
    db.prepare(`
      INSERT INTO webhook_events (event_key, event_type, kind, signature_ok, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run(eventKey, eventType, kind, signatureOk ? 1 : 0, payload);
    return true;
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) return false;
    throw err;
  }
}

function setWebhookOutcome(eventKey, outcome) {
  db.prepare('UPDATE webhook_events SET outcome = ? WHERE event_key = ?').run(outcome, eventKey);
}

function logRejectedWebhook({ eventType, kind, payload, outcome = 'Rejected: signature did not match' }) {
  db.prepare(`
    INSERT INTO webhook_events (event_key, event_type, kind, signature_ok, payload, outcome)
    VALUES (NULL, ?, ?, 0, ?, ?)
  `).run(eventType, kind, payload, outcome);
}

function listWebhooks(limit = 50) {
  return db.prepare('SELECT * FROM webhook_events ORDER BY id DESC LIMIT ?').all(limit);
}

function logApiCall({ app, method, path: p, status, code, ms }) {
  db.prepare('INSERT INTO api_calls (app, method, path, status, code, ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run(app, method, p, status ?? null, code ?? null, ms);
  db.prepare('DELETE FROM api_calls WHERE id <= (SELECT MAX(id) - 300 FROM api_calls)').run();
}

function listApiCalls(limit = 80) {
  return db.prepare('SELECT * FROM api_calls ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  db,
  getUser, saveUser, setPhone, updateVerification, setClaims, setLevel, addAlert, setFlags, forgetUser,
  listOffers, getOffer, createOffer, closeOffer, seedDemoOffers,
  createTrade, getTrade, listTradesFor, setTradeStatus, attachPartnerCheck, attachIdentity,
  savePartnerCheck, listPartnerChecks, latestSignedItems,
  startMerchantCheck, setMerchantQuote, getMerchantCheckById, getMerchantCheck, completeMerchantCheck, failMerchantCheck, listMerchantChecks,
  recordWebhook, setWebhookOutcome, logRejectedWebhook, listWebhooks,
  logApiCall, listApiCalls,
};
