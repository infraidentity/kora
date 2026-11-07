const crypto = require('crypto');
const express = require('express');
const { requireUser, accessToken } = require('../services/session');

// "Prove it with INFRA": Kora asks INFRA to prove facts about the signed-in
// person without receiving the data behind them (zero-knowledge proof), checks
// the proof, then shows that a copied proof is refused.
const FACTS = ['age_over_18', 'kyc_verified'];
// Each fact needs its own permission (proof:age_over_18, proof:kyc_verified).
const NO_PERMISSION = 'Kora doesn\x27t have your permission to prove this yet. Sign out, sign in again and allow "Prove you are over 18" and "Prove you are verified".';

module.exports = function zkRoutes({ infra }) {
  const router = express.Router();

  router.post('/zk/demo', requireUser, async (req, res) => {
    const ms = (t) => Date.now() - t;
    try {
      const token = await accessToken(req, infra);
      if (!token) return res.status(401).json({ ok: false, message: 'Sign in with INFRA again to try this.' });

      let t = Date.now();
      const ch = await infra.zkChallenge(token, req.user.id);
      if (ch.status === 404) return res.json({ ok: false, available: false, message: 'Proofs aren\'t switched on for Kora yet.' });
      if (ch.code === 'INSUFFICIENT_SCOPE') return res.json({ ok: false, message: NO_PERMISSION });
      if (!ch.ok) return res.json({ ok: false, message: ch.message || 'INFRA could not start a proof.' });
      const challengeMs = ms(t);

      t = Date.now();
      const pr = await infra.zkProof(token, req.user.id, ch.data.challenge_id, FACTS);
      if (!pr.ok) {
        const message = pr.code === 'INSUFFICIENT_SCOPE' ? NO_PERMISSION : pr.code === 'FACT_NOT_AVAILABLE'
          ? 'INFRA hasn\'t confirmed these facts for your account yet. Verify in INFRA Accounts, then try again.'
          : (pr.message || 'INFRA could not make the proof.');
        return res.json({ ok: false, message });
      }
      const proveMs = ms(t);

      t = Date.now();
      const check = await infra.zkVerify({ challenge: ch.data.challenge, facts: pr.data.facts, now: pr.data.now, proof: pr.data.proof, docType: pr.data.doc_type });
      const verifyMs = ms(t);

      // The same proof with a different challenge (as if copied to another session) must fail.
      const copied = await infra.zkVerify({ challenge: crypto.randomBytes(32).toString('base64'), facts: pr.data.facts, now: pr.data.now, proof: pr.data.proof, docType: pr.data.doc_type });

      return res.json({
        ok: Boolean(check.ok && check.data && check.data.valid),
        facts: pr.data.facts,
        doc_type: pr.data.doc_type,
        proof_kb: Math.round((pr.data.proof.length * 3) / 4 / 1024),
        timings: { challenge_ms: challengeMs, prove_ms: proveMs, verify_ms: verifyMs },
        copied_proof_refused: Boolean(copied.ok && copied.data && copied.data.valid === false),
      });
    } catch (err) {
      return res.status(502).json({ ok: false, message: 'INFRA is unreachable right now. Try again shortly.' });
    }
  });

  return router;
};
