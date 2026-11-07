const crypto = require('crypto');
const express = require('express');
const { requireUser, accessToken } = require('../services/session');

// "Prove it with INFRA": Kora asks INFRA to prove facts about the signed-in
// person without receiving the data behind them (zero-knowledge proof), checks
// each proof, then shows that a copied proof is refused.
//
// Kora tests every fact INFRA can prove. Each fact is proven on its own, so a
// fact the person hasn't verified shows "not confirmed" without stopping the
// others. Each needs its own permission, proof:<fact>, asked for at sign-in.
const FACTS = [
  'age_over_18', 'age_over_21', 'kyc_verified', 'unique_human', 'phone_verified',
  'address_verified', 'watchlist_clear', 'resident_country', 'resident_state', 'postal_region',
];
const PROOF_SCOPES = FACTS.map((f) => `proof:${f}`);
const AT_ONCE = 3; // proofs in flight at a time (INFRA's proof service is shared)

const NO_PERMISSION = 'Kora doesn\'t have your permission to prove this. Sign out, sign in again and allow "Prove facts about you".';

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

module.exports = function zkRoutes({ infra }) {
  const router = express.Router();

  router.post('/zk/demo', requireUser, async (req, res) => {
    try {
      const token = await accessToken(req, infra);
      if (!token) return res.status(401).json({ ok: false, message: 'Sign in with INFRA again to try this.' });

      let copied = null; // the first proof, re-checked with another challenge
      const results = await inBatches(FACTS, AT_ONCE, async (fact) => {
        const ch = await infra.zkChallenge(token, req.user.id);
        if (ch.status === 404) return { fact, status: 'off' };
        if (ch.code === 'INSUFFICIENT_SCOPE') return { fact, status: 'no_permission' };
        if (!ch.ok) return { fact, status: 'failed', message: ch.message };

        let t = Date.now();
        const pr = await infra.zkProof(token, req.user.id, ch.data.challenge_id, [fact]);
        const proveMs = Date.now() - t;
        if (!pr.ok) {
          if (pr.code === 'FACT_NOT_AVAILABLE') return { fact, status: 'not_confirmed' };
          if (pr.code === 'INSUFFICIENT_SCOPE') return { fact, status: 'no_permission' };
          return { fact, status: 'failed', message: pr.message };
        }

        t = Date.now();
        const check = await infra.zkVerify({ challenge: ch.data.challenge, facts: pr.data.facts, now: pr.data.now, proof: pr.data.proof, docType: pr.data.doc_type });
        const verifyMs = Date.now() - t;
        const valid = Boolean(check.ok && check.data && check.data.valid);
        if (valid && !copied) copied = pr.data;
        return {
          fact,
          status: valid ? 'proven' : 'failed',
          value: pr.data.facts[fact],
          prove_ms: proveMs,
          verify_ms: verifyMs,
          proof_kb: Math.round((pr.data.proof.length * 3) / 4 / 1024),
        };
      });

      if (results.every((r) => r.status === 'off')) {
        return res.json({ ok: false, available: false, message: 'Proofs aren\'t switched on for Kora yet.' });
      }
      if (results.every((r) => r.status === 'no_permission')) return res.json({ ok: false, message: NO_PERMISSION });

      // The same proof with a different challenge (as if copied to another session) must fail.
      let copiedRefused = null;
      if (copied) {
        const again = await infra.zkVerify({ challenge: crypto.randomBytes(32).toString('base64'), facts: copied.facts, now: copied.now, proof: copied.proof, docType: copied.doc_type });
        copiedRefused = Boolean(again.ok && again.data && again.data.valid === false);
      }

      const proven = results.filter((r) => r.status === 'proven');
      return res.json({
        ok: proven.length > 0 && results.every((r) => r.status !== 'failed'),
        results,
        facts: Object.fromEntries(proven.map((r) => [r.fact, r.value])),
        copied_proof_refused: copiedRefused,
      });
    } catch (err) {
      return res.status(502).json({ ok: false, message: 'INFRA is unreachable right now. Try again shortly.' });
    }
  });

  return router;
};

module.exports.FACTS = FACTS;
module.exports.PROOF_SCOPES = PROOF_SCOPES;
