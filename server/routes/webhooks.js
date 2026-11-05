const express = require('express');
const config = require('../config');
const db = require('../db');
const { verifySignature } = require('../infra/signatures');

/**
 * What INFRA tells Kora without being asked.
 *
 *   POST /webhooks/infra     every webhook event (register this URL in the
 *                            developer portal, with WEBHOOK_SECRET)
 *   POST /webhooks/deletion  deletion callbacks (the app's "deletion
 *                            callback URL" in the developer portal)
 *
 * Both are verified against the raw body before anything is read, recorded
 * once per event (INFRA retries), and answered quickly.
 *
 * INFRA only sends events about people who share with Kora, but a person
 * can be forgotten here (deleted their Kora data) while still sharing, so
 * events about people Kora doesn't hold are recorded and ignored.
 */
const raw = express.raw({ type: '*/*', limit: '256kb' });

function parse(buf) {
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

const ADDRESS_CLAIMS = ['address_verified', 'state_resident', 'postal_region'];
const ID_CLAIMS = ['kyc_verified', 'identity_verified'];
const label = (t) => String(t || '').replace(/_/g, ' ');

/**
 * Apply one INFRA event to Kora's records, leave the person a note about it
 * (shown on their pages), and return a short sentence for the developer
 * panel saying what Kora did. Simulated events (from the developer portal's
 * test users) are handled exactly like real ones, and marked as tests.
 */
function applyEvent(type, data, { simulated = false } = {}) {
  const userId = data?.user_id;
  const known = userId && db.getUser(userId);
  if (!known && type !== 'consent_granted') {
    return "Ignored: Kora doesn't hold this person (never signed in, or Kora already deleted their data). Sign in to Kora with them again to see the next events.";
  }
  const note = (tone, text) => db.addAlert(userId, { tone, text, eventType: type, simulated });

  switch (type) {
    case 'kyc_verified': {
      const level = data.kyc_level || 'level_1';
      db.updateVerification(userId, { kyc_level: level, kyc_status: 'verified', verified_at: data.verified_at });
      if (level === 'level_2') {
        db.setFlags(userId, { address_stale: null, reject_reason: null });
        note('ok', 'INFRA verified your address. Full trading limits are open (with an over-18 confirmation).');
        return 'Address verified (level 2): address warning cleared, Full limits unlocked.';
      }
      db.setFlags(userId, { id_expiring: null, id_grace: null, reject_reason: null });
      note('ok', 'INFRA verified your ID. You can trade.');
      return 'ID verified (level 1): trading opened, ID warnings cleared.';
    }

    case 'kyc_rejected': {
      const reason = data.reject_reason || null;
      if (data.reject_type === 'ADDRESS_WITHDRAWN') {
        // Only the address went: the ID check still stands.
        if (known.kyc_level === 'level_2') db.setLevel(userId, 'level_1');
        db.setClaims(userId, known.claims.filter((c) => !ADDRESS_CLAIMS.includes(c.claim_type)));
        db.setFlags(userId, { address_stale: null });
        note('warn', 'INFRA no longer confirms your address, so you are back on Starter limits. Verify your address again in INFRA Accounts for Full limits.');
        return 'Address no longer verified: dropped to level 1 and removed address facts; ID verification kept.';
      }
      db.updateVerification(userId, { kyc_status: 'rejected' });
      db.setFlags(userId, { reject_reason: reason });
      note('bad', `INFRA could not verify your ID${reason ? ': ' + reason : '.'} Try again in INFRA Accounts.`);
      return `ID rejected${data.reject_type ? ' (' + data.reject_type + ')' : ''}: trading paused, reason shown to the person.`;
    }

    case 'kyc_status_updated': {
      const status = data.status;
      const meta = data.metadata || {};
      switch (status) {
        case 'document_expiring_soon':
          db.setFlags(userId, { id_expiring: { expiry_date: meta.expiry_date || null, days_remaining: meta.days_remaining ?? null } });
          note('warn', `Your ID expires soon${meta.days_remaining != null ? ' (in ' + meta.days_remaining + ' days)' : ''}. Renew it in INFRA Accounts to keep trading without a break.`);
          return 'ID expiring soon: warning shown; trading continues.';
        case 'document_expired_grace_period':
          db.setFlags(userId, { id_expiring: null, id_grace: { expiry_date: meta.expiry_date || null, grace_days_remaining: meta.grace_days_remaining ?? null } });
          note('bad', `Your ID has expired. You can keep trading for ${meta.grace_days_remaining != null ? meta.grace_days_remaining + ' more days' : 'a short while'}; verify a valid ID in INFRA Accounts before then.`);
          return `ID expired, grace period (${meta.grace_days_remaining ?? '?'} days): trading continues with a warning.`;
        case 'document_expired':
          db.updateVerification(userId, { kyc_status: 'expired' });
          db.setFlags(userId, { id_expiring: null, id_grace: null });
          note('bad', 'Your ID has expired and the grace period is over, so trading is paused. Verify a valid ID in INFRA Accounts.');
          return 'ID expired (grace over): trading paused.';
        case 'poa_past_default_window':
          db.setFlags(userId, { address_stale: { since: data.updated_at || new Date().toISOString(), verified_at: meta.verified_at || null } });
          note('warn', "INFRA checked your address a while ago. Kora's rule is that Full limits need a recent address, so you're on Starter limits until you refresh it.");
          return "Address past INFRA's freshness window: Kora's rule applied, Full limits paused (Starter kept).";
        case 'verified':
          db.updateVerification(userId, { kyc_status: 'verified' });
          db.setFlags(userId, { id_expiring: null, id_grace: null, reject_reason: null });
          note('ok', 'INFRA confirmed your verification again.');
          return 'Verification restored: trading open.';
        default:
          if (!status) return 'No status in event.';
          // Any other change away from verified (suspended, pending...) stops trading.
          db.updateVerification(userId, { kyc_status: status });
          note(status === 'pending' ? 'info' : 'bad', `INFRA changed your verification to "${label(status)}". Trading is paused until it is verified again.`);
          return `Status is now ${status}: trading paused.`;
      }
    }

    case 'claim_issued': {
      const claims = known.claims.filter((c) => c.claim_type !== data.claim_type);
      claims.push({ claim_type: data.claim_type, provider: data.provider, proof_hash: data.proof_hash, expires_at: data.expires_at });
      db.setClaims(userId, claims);
      note('ok', `INFRA confirmed a new fact: ${label(data.claim_type)}.`);
      return `Added fact ${data.claim_type}.`;
    }

    case 'claim_revoked': {
      db.setClaims(userId, known.claims.filter((c) => c.claim_type !== data.claim_type));
      if (data.reason === 'document_expired' && ID_CLAIMS.includes(data.claim_type)) {
        // The ID behind the verification expired and its grace period ended.
        db.updateVerification(userId, { kyc_status: 'expired' });
        db.setFlags(userId, { id_expiring: null, id_grace: null });
        note('bad', 'Your ID expired, so INFRA withdrew its confirmation and trading is paused. Verify a valid ID in INFRA Accounts.');
        return `Removed fact ${data.claim_type} (ID expired): trading paused.`;
      }
      note('warn', `INFRA withdrew a fact: ${label(data.claim_type)}${data.reason ? ' (' + label(data.reason) + ')' : ''}.`);
      return `Removed fact ${data.claim_type}${data.reason ? ' (' + data.reason + ')' : ''}.`;
    }

    case 'consent_granted':
      // The phone number arrives here too when the person allowed phone:read.
      if (data.phone && data.phone.phone_number && db.getUser(userId)) {
        db.setPhone(userId, { number: data.phone.phone_number, verified: data.phone.phone_verified === true });
        return 'Noted. Saved the phone number the person shared.';
      }
      return 'Noted.';

    case 'consent_revoked':
    case 'user_deleted':
    case 'data_deletion_requested':
      db.forgetUser(userId);
      return 'Deleted everything Kora held about this person and signed them out.';

    default:
      return 'Ignored: Kora does not use this event.';
  }
}

module.exports = function webhookRoutes({ infra }) {
  const router = express.Router();

  router.post('/infra', raw, (req, res) => {
    const body = parse(req.body);
    const type = req.get('X-Event-Type') || body?.event_type || 'unknown';
    if (!verifySignature({ secret: config.webhookSecret, rawBody: req.body, signature: req.get('X-Webhook-Signature') })) {
      db.logRejectedWebhook({ eventType: type, kind: 'webhook', payload: null });
      return res.status(401).json({ received: false, error: 'invalid signature' });
    }
    if (!body) return res.status(400).json({ received: false, error: 'invalid JSON' });

    // data_deletion_requested has its fields at the top level, not under data.
    const data = body.data || body;
    const key = body.event_id || req.get('X-Delivery-Id') || null;
    if (key && !db.recordWebhook({ eventKey: key, eventType: type, kind: 'webhook', signatureOk: true, payload: JSON.stringify(body) })) {
      return res.json({ received: true, duplicate: true });
    }

    const outcome = (body.simulated ? '[Test event] ' : '') + applyEvent(type, data, { simulated: Boolean(body.simulated) });
    if (key) db.setWebhookOutcome(key, outcome);
    if (type === 'data_deletion_requested' && data.deletion_request_id) acknowledge(data.deletion_request_id, key);
    res.json({ received: true });
  });

  router.post('/deletion', raw, (req, res) => {
    const body = parse(req.body);
    if (!verifySignature({ secret: config.webhookSecret, rawBody: req.body, signature: req.get('X-Deletion-Signature') })) {
      // An ordinary webhook (it carries X-Webhook-Signature, not
      // X-Deletion-Signature) means a webhook in the INFRA portal points at
      // this deletion address. Say so, with the event's real type.
      if (req.get('X-Webhook-Signature') && !req.get('X-Deletion-Signature')) {
        db.logRejectedWebhook({
          eventType: req.get('X-Event-Type') || body?.event_type || 'webhook',
          kind: 'deletion',
          payload: null,
          outcome: 'Refused: this is a normal webhook sent to the deletion address. A webhook in the INFRA portal points here; delete it and use /webhooks/infra.',
        });
        return res.status(401).json({ acknowledged: false, error: 'webhook sent to the deletion address' });
      }
      db.logRejectedWebhook({ eventType: 'data_deletion_requested', kind: 'deletion', payload: null });
      return res.status(401).json({ acknowledged: false, error: 'invalid signature' });
    }
    if (!body?.deletion_request_id || !body.user_id) return res.status(400).json({ acknowledged: false, error: 'missing fields' });

    const key = `deletion:${body.deletion_request_id}`;
    const fresh = db.recordWebhook({ eventKey: key, eventType: body.event_type || 'data_deletion_requested', kind: 'deletion', signatureOk: true, payload: JSON.stringify(body) });
    if (fresh) {
      db.forgetUser(body.user_id);
      db.setWebhookOutcome(key, 'Deleted everything Kora held about this person. Acknowledged.');
    }
    // Deletion is done before we answer, so it is safe to acknowledge here.
    res.json({ acknowledged: true, deletion_request_id: body.deletion_request_id });
  });

  /** For deletions that arrive as a webhook event, confirm through the API. */
  function acknowledge(deletionRequestId, key) {
    infra.acknowledgeDeletion(deletionRequestId)
      .then((r) => db.setWebhookOutcome(key, r.ok ? 'Deleted and acknowledged to INFRA.' : `Deleted; acknowledgement failed (${r.code}).`))
      .catch(() => db.setWebhookOutcome(key, 'Deleted; INFRA unreachable for acknowledgement.'));
  }

  return router;
};

module.exports.applyEvent = applyEvent;
