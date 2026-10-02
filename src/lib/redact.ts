/**
 * Redaction for operator-facing log lines.
 *
 * WHY THIS EXISTS
 *
 * The send worker failed silently: when `schedule_retry` ran, the recipient row
 * was updated and nothing was written anywhere. Diagnosing "why did this
 * campaign stall" therefore meant guessing from `lastError` on 218 rows with no
 * correlation, no timestamps, and no record of how many attempts had been made.
 * That is a direct cause of the stuck-recipient incident this code was written
 * to prevent being undiagnosable next time.
 *
 * The fix is a log line — which immediately creates the opposite risk. Provider
 * errors are the single richest source of leaked secrets in an email system:
 * `SMTP servers do quote credentials back` (see `classifySmtpError`), OAuth
 * libraries put access and refresh tokens in error objects, and API errors
 * routinely echo the address a token was issued to. None of that may reach a
 * log file that gets shipped, grepped, or pasted into a ticket.
 *
 * So every field that is not a bare identifier goes through {@link redactText}
 * first. The rule applied throughout: identifiers we generated (cuids,
 * account ids) are logged raw because they are useless to an attacker and
 * essential for diagnosis; anything derived from the provider or the server is
 * masked or dropped.
 */

/**
 * Ordered replacement patterns.
 *
 * Order matters — the more specific patterns must run first, or a generic rule
 * would consume the part of the text a later rule needs to match. OAuth token
 * prefixes are matched before the generic `token:` rule, and credential-in-URL
 * before the email rule that would otherwise mask only half of it.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Credential-bearing URL: scheme://user:pass@host. Must precede the email rule.
  [/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted-credential]@"],

  // Google OAuth access/refresh token literals. Refresh tokens are `1//`
  // followed by a base64url blob that legitimately contains `/`, so the tail
  // must be matched as a run of non-space characters rather than word
  // characters -- `1/[\w-]{10,}` silently misses the real format.
  [/\b(?:ya29\.[\w-]+|1\/\/\S{10,}|gh[opsu]_-?[\w-]{8,})/g, "[redacted-token]"],

  // `access_token=…`, `"refreshToken": "…"`, `password=…`, `Authorization: Bearer …`.
  [
    /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|pwd|secret|passphrase|bearer)\b\s*"?\s*[:=]\s*"?[^\s",}]+/gi,
    "[redacted-credential]",
  ],

  // Bare `Authorization: Bearer <token>` with no `:`/`=` separator.
  [/\bBearer\s+[\w.~+/=-]{8,}/gi, "Bearer [redacted-token]"],

  // Encrypted-blob shapes (iv:ciphertext:tag from src/lib/encryption.ts).
  [/\b[0-9a-f]{24,}:[A-Za-z0-9+/=]{16,}:[0-9a-f]{16,}\b/gi, "[redacted-ciphertext]"],

  // Email addresses. A log line must not become a recipient list, and the
  // CampaignRecipient id already identifies the row unambiguously.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
];

/** Default cap. Provider errors are one sentence; anything longer is noise. */
const DEFAULT_MAX_LENGTH = 200;

/**
 * Mask credential-shaped substrings and truncate `text` for logging.
 *
 * This is a defence-in-depth filter, not a guarantee: it removes the known
 * leak shapes, and truncation bounds what an unrecognised shape can cost. It is
 * deliberately never used as a substitute for not logging a secret in the first
 * place — callers must still avoid passing one.
 */
export function redactText(text: string, maxLength: number = DEFAULT_MAX_LENGTH): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (out.length > maxLength) {
    return `${out.slice(0, maxLength)}…`;
  }
  return out;
}

/** The fields a structured send-failure log line is allowed to carry. */
export interface SendFailureLog {
  /** Stable event name, so logs can be filtered without parsing prose. */
  event: "campaign_send_failure";
  /** ISO-8601. The worker log previously had NO timestamps at all. */
  ts: string;
  campaignId: string;
  recipientId: string;
  provider: string;
  accountId: string;
  /** 1 = first attempt, 2 = first retry, … the value the retry budget spends. */
  attempt: number;
  /** `temporary` | `quota` | `auth` | `permanent` — from the send classifier. */
  kind: string;
  /** `schedule_retry` | `fail_permanent` | `quota_backoff` | `auth_required`. */
  action: string;
  /** Null for terminal outcomes, which have no next attempt. */
  retryAfterSeconds: number | null;
  /** Redacted provider summary. */
  detail: string;
}

/**
 * Build the structured line for a failed send and emit it.
 *
 * Emits exactly one line, JSON-encoded so it is machine-parseable, and passes
 * every provider-derived string through {@link redactText}. The recipient's
 * ADDRESS is deliberately absent — the id is the durable correlation key, and
 * omitting the address is what keeps this from being a recipient list.
 */
export function logSendFailure(fields: Omit<SendFailureLog, "event" | "ts" | "detail"> & { detail: string }): SendFailureLog {
  const entry: SendFailureLog = {
    event: "campaign_send_failure",
    ts: new Date().toISOString(),
    campaignId: fields.campaignId,
    recipientId: fields.recipientId,
    provider: fields.provider,
    accountId: fields.accountId,
    attempt: fields.attempt,
    kind: fields.kind,
    action: fields.action,
    retryAfterSeconds: fields.retryAfterSeconds,
    detail: redactText(fields.detail),
  };
  console.warn(JSON.stringify(entry));
  return entry;
}
