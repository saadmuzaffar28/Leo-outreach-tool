/**
 * Structured logging for email verification (Phase 18).
 *
 * Same convention as src/lib/redact.ts: one JSON line per event, emitted with
 * console.warn, so it can be grepped by `event`.
 *
 * PII rule: addresses are NEVER logged raw. `maskEmail` keeps just enough of
 * the local part to correlate a specific address during debugging
 * ("j***@example.com") without the log becoming a recipient list, and every
 * provider-derived string goes through `redactText` (credentials, tokens).
 * No SMTP credentials, passwords or OAuth tokens are ever passed to these
 * helpers.
 */

import { redactText } from "@/lib/redact";

export type VerificationLogEvent =
  | "email_verification_started"
  | "email_verification_completed"
  | "email_verification_failed"
  | "email_verification_cached"
  | "email_verification_retry"
  | "email_verification_timeout"
  | "email_verification_queued";

/** "john.doe@example.com" → "j***@example.com"; short locals → "***@domain". */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "[invalid-address]";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0]}***@${domain}`;
}

export interface VerificationLogFields {
  event: VerificationLogEvent;
  /** Masked address — the correlation key for one verification. */
  email?: string;
  userId?: string;
  jobId?: string;
  status?: string;
  confidence?: number;
  errorCode?: string;
  attempt?: number;
  durationMs?: number;
  retryAfterSeconds?: number;
  /** Redacted provider/engine detail. */
  detail?: string;
}

/** Emit one structured verification log line. */
export function logVerification(fields: VerificationLogFields): void {
  const entry = {
    ts: new Date().toISOString(),
    event: fields.event,
    ...(fields.email ? { email: maskEmail(fields.email) } : {}),
    ...(fields.userId ? { userId: fields.userId } : {}),
    ...(fields.jobId ? { jobId: fields.jobId } : {}),
    ...(fields.status ? { status: fields.status } : {}),
    ...(fields.confidence !== undefined ? { confidence: fields.confidence } : {}),
    ...(fields.errorCode ? { errorCode: fields.errorCode } : {}),
    ...(fields.attempt !== undefined ? { attempt: fields.attempt } : {}),
    ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
    ...(fields.retryAfterSeconds !== undefined ? { retryAfterSeconds: fields.retryAfterSeconds } : {}),
    ...(fields.detail ? { detail: redactText(fields.detail, 300) } : {}),
  };
  console.warn(JSON.stringify(entry));
}
