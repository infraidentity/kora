/**
 * INFRA answers with codes; traders see sentences. Anything not listed falls
 * back to INFRA's own message, then to a general one.
 */
const MESSAGES = {
  // INFRA Connect
  INVALID_CONNECT_CODE: "That code didn't work. Codes last 10 minutes and work once, so ask for a new one.",
  CONNECT_CODE_REQUIRED: 'Paste the INFRA Connect code first. It looks like CNX-XXXX-XXXX.',
  CONNECT_UNAVAILABLE: "INFRA couldn't check that code just now. Please try again.",
  SUBSCRIPTION_REQUIRED: "Kora's INFRA plan doesn't cover this right now.",
  INVALID_SCOPES: 'Kora asked INFRA for something it is not allowed to.',

  // Credentials and setup
  INVALID_CREDENTIALS: "Kora's INFRA credentials are wrong. Check CLIENT_ID and CLIENT_SECRET.",
  MISSING_CREDENTIALS: "Kora's INFRA credentials are missing.",
  invalid_client: "Kora's INFRA credentials are wrong. Check CLIENT_ID and CLIENT_SECRET.",
  invalid_grant: 'That sign-in link has expired. Please sign in again.',

  // PayV
  PAYV_DISABLED: "INFRA hasn't turned PayV on yet.",
  PAYV_NOT_ENABLED_FOR_APP: 'The merchant app must be set to PayV billing in the INFRA developer portal.',
  PAYV_LIVE_DISABLED: 'Live PayV payments are not open yet. Use the merchant app\'s test credentials with a sandbox user.',
  CONSENT_REQUIRED: 'You need to share your INFRA verification with Kora first. Paste a fresh INFRA Connect code.',
  VERIFICATION_POLICY_NOT_SATISFIED: "Your INFRA verification doesn't meet Kora's merchant requirements yet.",
  VERIFICATION_REQUIRED: 'Finish verifying your identity in INFRA Accounts first. Verifying is free.',
  PAYER_NOT_LINKED: "This wallet isn't linked to your INFRA account. Link it below, or switch to a linked wallet. Nothing has been charged.",
  PAYER_MISMATCH: 'That payment was signed by a different wallet than the one Kora asked about. Nothing was charged. Try again with the same wallet.',
  PAYER_ADDRESS_REQUIRED: 'Connect your wallet first so INFRA can check it.',
  INVALID_PAYER_ADDRESS: 'That wallet address looks wrong. Reconnect your wallet.',
  PAYER_CHECK_FAILED: "INFRA couldn't check your wallet just now. Please try again.",
  PAYER_UNKNOWN: 'INFRA could not tell which wallet paid. Nothing was charged. Try again.',
  PAYMENT_REQUEST_EXPIRED: 'This payment request expired. Start again for a new one. Nothing was charged.',
  PAYMENT_REQUEST_CLOSED: 'This payment request is closed. Start again for a new one.',
  PAYMENT_ALREADY_CONSUMED: 'This payment was already used.',
  PAYMENT_REQUEST_NOT_FOUND: 'Kora could not find this payment request. Start again.',
  PAYMENT_VERIFICATION_FAILED: 'The payment was not accepted. Check you have enough test USDC on Base Sepolia. Nothing was charged.',
  PAYMENT_SETTLEMENT_FAILED: "The payment couldn't be completed. Nothing was charged and no data was shared.",
  DELIVERY_FAILED: "INFRA couldn't prepare your verification. Nothing was charged.",
  WALLET_LINK_FAILED: "The wallet couldn't be linked. Check you signed with the same wallet and try again.",
  ENVIRONMENT_MISMATCH: "Test credentials only work with INFRA sandbox users, and live credentials only with real accounts.",

  // Claims
  MISSING_PROOF_HASH: 'There is no proof to check yet.',

  // General
  RATE_LIMIT_EXCEEDED: 'Too many attempts. Please wait a minute and try again.',
  INFRA_UNREACHABLE: "Kora can't reach INFRA right now. Please try again in a moment.",
};

const GENERIC = 'Something went wrong. Please try again.';
// INFRA's own sentences are fine to show; codes and stack-ish text are not.
const LOOKS_TECHNICAL = /[A-Z]{3,}_[A-Z_]+|\bundefined\b|\bnull\b|stack|ECONN|status code \d+/;

function messageFor(result, fallback = GENERIC) {
  if (!result) return fallback;
  if (result.code && MESSAGES[result.code]) return MESSAGES[result.code];
  if (result.message && !LOOKS_TECHNICAL.test(result.message)) return result.message;
  return fallback;
}

module.exports = { MESSAGES, messageFor };
