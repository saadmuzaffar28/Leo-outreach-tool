/**
 * Decision helpers for the send queue — pure functions, unit tested.
 */

export type SendErrorKind = "temporary" | "quota" | "auth" | "permanent";

export interface SendErrorInfo {
  retryable: boolean;
  message: string;
  kind: SendErrorKind;
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function extractCode(err: unknown): number | undefined {
  const e = err as { code?: unknown };
  const code = e?.code;
  if (typeof code === "number") return code;
  if (typeof code === "string" && /^\d{3}$/.test(code)) return Number(code);
  return undefined;
}

/**
 * Classifies a throw from the Gmail API / network layer.
 * Temporary issues (rate limits, 5xx, network) → retryable.
 * Permanent issues (invalid recipient, revoked grant, bad request) → not retryable.
 */
export function classifySendError(err: unknown): SendErrorInfo {
  const e = err as {
    name?: string;
    code?: unknown;
    message?: string;
    reason?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };

  const message = e?.message ?? "Unknown error";

  if (e?.code && typeof e.code === "string" && NETWORK_CODES.has(e.code)) {
    return { retryable: true, kind: "temporary", message: `Network error (${e.code}): ${message}` };
  }
  if (e?.name === "FetchError" || message.includes("fetch failed") || message.includes("socket hang up")) {
    return { retryable: true, kind: "temporary", message };
  }

  if (message.toLowerCase().includes("invalid_grant")) {
    return { retryable: false, kind: "auth", message: "OAuth grant invalid or revoked — reconnect the sending account" };
  }

  const httpCode = extractCode(err);
  if (httpCode !== undefined) {
    if (httpCode === 429) {
      return { retryable: true, kind: "quota", message: "Rate limited by the email provider (429)" };
    }
    if (httpCode >= 500) {
      return { retryable: true, kind: "temporary", message: `Temporary server error (${httpCode})` };
    }
    if (httpCode === 400) {
      return { retryable: false, kind: "permanent", message: `Invalid request rejected by the email provider (400): ${message}` };
    }
    if (httpCode === 404) {
      return { retryable: false, kind: "permanent", message: `Recipient or resource not found (404): ${message}` };
    }
    if (httpCode === 401) {
      return { retryable: true, kind: "temporary", message: `Authentication error (401) — refreshing token` };
    }
    if (httpCode === 403) {
      const reason = e?.errors?.[0]?.reason?.toLowerCase() ?? "";
      if (
        reason.includes("rate") ||
        reason.includes("quota") ||
        reason.includes("send_limit") ||
        reason.includes("daily_limit") ||
        message.toLowerCase().includes("rate limit") ||
        message.toLowerCase().includes("quota") ||
        message.toLowerCase().includes("throttl")
      ) {
        return { retryable: true, kind: "quota", message: `Email provider quota/rate limit (403): ${message}` };
      }
      // Other 403s (permissions, rejected message) — do not hammer.
      return { retryable: false, kind: "permanent", message: `Access/rejected by the email provider (403): ${message}` };
    }
  }

  const reason = e?.reason ?? "";
  if (reason && reason !== "") {
    return { retryable: true, kind: "temporary", message: `Temporary error: ${reason}` };
  }

  return { retryable: false, kind: "permanent", message };
}

/**
 * Exponential backoff in seconds with jitter, exponential-growth cap.
 * attemptsUsed: number of failures already recorded (0 = first failure).
 */
export function computeBackoffSeconds(
  attemptsUsed: number,
  baseSeconds: number,
  capSeconds = 6 * 60 * 60,
): number {
  const exponent = Math.min(attemptsUsed, 10);
  const raw = baseSeconds * 2 ** exponent;
  const capped = Math.min(raw, capSeconds);
  const jitter = Math.floor(Math.random() * (capped / 4 + 1));
  const rounded = Math.round((capped + jitter) / 6) * 6;
  return Math.max(1, Math.min(rounded, capSeconds));
}

/**
 * Decides whether another attempt should be scheduled.
 * Permanent failures never retry; retryable failures stop after maxRetries.
 */
export function shouldRetry(info: SendErrorInfo, attemptsUsed: number, maxRetries: number): boolean {
  if (!info.retryable) return false;
  return attemptsUsed < maxRetries;
}

export interface RetryPolicy {
  maxRetryAttempts: number;
  baseRetryDelaySeconds: number;
  maxRetryDelaySeconds: number;
}

export type SendDecision =
  | { action: "schedule_retry"; retryAfterSeconds: number; message: string }
  | { action: "fail_permanent"; message: string }
  | { action: "quota_backoff"; retryAfterSeconds: number; message: string }
  | { action: "auth_required"; message: string };

/**
 * Single decision point for every send failure.
 * - quota (429 / quota-flavored 403) → quota_backoff (account is throttled).
 * - auth (invalid_grant / revoked grant) → auth_required (operator must reconnect).
 * - temporary (network / 5xx / 401) → schedule_retry with exponential backoff.
 * - permanent → fail_permanent. Retry budget exhausted → fail_permanent.
 */
export function decideSendError(err: unknown, attemptsUsed: number, policy: RetryPolicy): SendDecision {
  const info = classifySendError(err);

  if (info.kind === "auth") {
    return { action: "auth_required", message: info.message };
  }
  if (info.kind === "quota") {
    return {
      action: "quota_backoff",
      retryAfterSeconds: computeBackoffSeconds(attemptsUsed, policy.baseRetryDelaySeconds, policy.maxRetryDelaySeconds),
      message: info.message,
    };
  }
  if (!info.retryable || attemptsUsed >= policy.maxRetryAttempts) {
    const gaveUp =
      attemptsUsed >= policy.maxRetryAttempts
        ? `Gave up after ${attemptsUsed} attempt(s): ${info.message}`
        : info.message;
    return { action: "fail_permanent", message: gaveUp };
  }
  return {
    action: "schedule_retry",
    retryAfterSeconds: computeBackoffSeconds(attemptsUsed, policy.baseRetryDelaySeconds, policy.maxRetryDelaySeconds),
    message: info.message,
  };
}