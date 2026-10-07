/**
 * Normalized email-verification model for Leo Outreach.
 *
 * This is the ONLY verification vocabulary the rest of the application sees.
 * Engine-specific payload shapes (AfterShip/email-verifier) never leave
 * `src/lib/verification/aftership-adapter.ts`.
 *
 * Status semantics — deliberately conservative. Nothing here ever means
 * "guaranteed delivery" or "guaranteed inbox placement":
 *
 *   VALID      High-confidence evidence the mailbox is likely reachable.
 *   INVALID    Strong evidence the address cannot receive mail
 *              (bad syntax, dead domain, no MX, or a clear SMTP rejection).
 *   CATCH_ALL  The mail server accepts arbitrary recipients, so mailbox
 *              existence could not be confirmed.
 *   RISKY      Potentially deliverable, but carries a significant warning
 *              (disposable domain, role account, full mailbox, disabled
 *              mailbox, policy-level SMTP refusal of our sender).
 *   UNKNOWN    Verification could not reliably determine mailbox status
 *              (timeout, greylisting, 4xx, connection refused/blocked port 25,
 *              anti-enumeration, engine unavailable, SMTP checks disabled).
 */

export const VERIFICATION_STATUSES = [
  "VALID",
  "INVALID",
  "CATCH_ALL",
  "RISKY",
  "UNKNOWN",
] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Campaign send-gate policies. Default is OFF for backward compatibility. */
export const VERIFICATION_POLICIES = [
  "OFF",
  "WARN",
  "BLOCK_INVALID",
  "BLOCK_INVALID_AND_RISKY",
] as const;

export type VerificationPolicy = (typeof VERIFICATION_POLICIES)[number];

/**
 * Bump when the adapter's status/confidence mapping changes, so old rows can
 * be told apart from new ones (and re-verified deliberately if desired).
 */
export const VERIFICATION_VERSION = "1.0.0";

/** Engine identifier persisted on every row. */
export const VERIFICATION_PROVIDER = "aftership";

/**
 * A fully normalized verification result — what the engine layer returns and
 * what the service layer persists. Mirrors the EmailVerification columns.
 */
export interface VerificationResult {
  /** Address as submitted. */
  email: string;
  /** Trimmed + lowercased — the cache key. */
  normalizedEmail: string;
  status: VerificationStatus;
  /** Heuristic 0–100. Not a machine-learning probability. */
  confidence: number;
  syntaxValid: boolean;
  /** Domain parses and resolves (NXDOMAIN ⇒ false). */
  domainValid: boolean;
  mxValid: boolean;
  /** SMTP RCPT for this exact mailbox was accepted. */
  smtpReachable: boolean;
  catchAll: boolean;
  disposable: boolean;
  roleAccount: boolean;
  freeProvider: boolean;
  /** e.g. "gmai.com" → "gmail.com", when the engine detected a typo. */
  typoSuggestion: string | null;
  provider: string;
  /** Stable machine-readable reason, e.g. "syntax_invalid", "smtp_timeout". */
  errorCode: string | null;
  /** Short human detail (already redacted of credentials by the adapter). */
  errorMessage: string | null;
  checkedAt: Date;
  verificationVersion: string;
}

/**
 * Outcome of asking the engine about one address. `retryable` tells the
 * queue whether a failure may be retried with backoff (timeouts, greylisting,
 * 4xx, engine down) — permanent answers are never retried.
 */
export type EngineOutcome =
  | { ok: true; raw: unknown }
  | { ok: false; errorCode: string; errorMessage: string; retryable: boolean };
