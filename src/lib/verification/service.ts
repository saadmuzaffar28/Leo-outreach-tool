/**
 * Verification service — cache, persistence, enqueueing, gate lookups.
 *
 * Layering (Phase 4):
 *   engine.ts (transport) → aftership-adapter.ts (normalize) → scoring.ts
 *   → THIS module (cache/persist/queue) → API/worker/UI.
 *
 * Caching (Phase 7): one stored row per (user, normalized email). A row whose
 * `expiresAt` is in the future is reused without touching the engine; `force`
 * bypasses the cache. Transient ENGINE failures (service down / timeout) are
 * never persisted, so an outage cannot poison the cache for a week.
 */

import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import type { EmailVerification, Prisma } from "@prisma/client";
import { verifyAndNormalize, engineFailureResult } from "./engine";
import { isPlausibleEmail, normalizeEmail, normalizeOrNull } from "./normalize";
import { syntaxFailureResult } from "./aftership-adapter";
import { logVerification } from "./log";
import {
  VERIFICATION_PROVIDER,
  VERIFICATION_VERSION,
  type VerificationResult,
  type VerificationStatus,
} from "./types";

/** Error codes that mean "the engine didn't answer" — never persisted. */
const TRANSIENT_ENGINE_ERRORS = new Set([
  "service_unavailable",
  "service_misconfigured",
  "engine_timeout",
  "engine_bad_response",
  "engine_error",
]);

function isTransientEngineError(errorCode: string | null): boolean {
  return errorCode !== null && TRANSIENT_ENGINE_ERRORS.has(errorCode);
}

function cacheTtlDays(): number {
  return env.EMAIL_VERIFICATION_CACHE_TTL_DAYS;
}

/** A stored row may be reused when it exists and has not expired. */
export function isCacheFresh(row: Pick<EmailVerification, "expiresAt">, now: Date = new Date()): boolean {
  return row.expiresAt.getTime() > now.getTime();
}

/** Persist (upsert) a normalized result as the user's current record. */
export async function saveResult(userId: string, result: VerificationResult): Promise<EmailVerification> {
  const now = new Date();
  return prisma.emailVerification.upsert({
    where: {
      userId_normalizedEmail: { userId, normalizedEmail: result.normalizedEmail },
    },
    create: {
      userId,
      email: result.email,
      normalizedEmail: result.normalizedEmail,
      status: result.status,
      confidence: result.confidence,
      syntaxValid: result.syntaxValid,
      domainValid: result.domainValid,
      mxValid: result.mxValid,
      smtpReachable: result.smtpReachable,
      catchAll: result.catchAll,
      disposable: result.disposable,
      roleAccount: result.roleAccount,
      freeProvider: result.freeProvider,
      provider: result.provider,
      typoSuggestion: result.typoSuggestion,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      verificationVersion: result.verificationVersion,
      checkedAt: result.checkedAt,
      expiresAt: new Date(now.getTime() + cacheTtlDays() * 24 * 60 * 60 * 1000),
    },
    update: {
      email: result.email,
      status: result.status,
      confidence: result.confidence,
      syntaxValid: result.syntaxValid,
      domainValid: result.domainValid,
      mxValid: result.mxValid,
      smtpReachable: result.smtpReachable,
      catchAll: result.catchAll,
      disposable: result.disposable,
      roleAccount: result.roleAccount,
      freeProvider: result.freeProvider,
      provider: result.provider,
      typoSuggestion: result.typoSuggestion,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      verificationVersion: result.verificationVersion,
      checkedAt: result.checkedAt,
      expiresAt: new Date(now.getTime() + cacheTtlDays() * 24 * 60 * 60 * 1000),
    },
  });
}

export interface SingleVerifyOutcome {
  result: VerificationResult;
  /** True when a fresh stored row was reused instead of the engine. */
  cached: boolean;
  /** The persisted row, when the result was stored (null for transient failures). */
  row: EmailVerification | null;
}

/**
 * Verify one address synchronously (single/individual verification).
 *
 * Order: format check → fresh cache → engine → persist.
 * Throws only for malformed input; engine trouble becomes an UNKNOWN result.
 */
export async function verifySingle(
  userId: string,
  email: string,
  opts: { force?: boolean; jobId?: string } = {},
): Promise<SingleVerifyOutcome> {
  const normalized = normalizeEmail(email);
  const jobId = opts.jobId;

  // Definitive local verdicts need no network round trip.
  if (!isPlausibleEmail(normalized)) {
    const result = syntaxFailureResult(email);
    logVerification({ event: "email_verification_completed", email: normalized, userId, jobId, status: result.status, confidence: result.confidence, errorCode: result.errorCode ?? undefined });
    const row = await saveResult(userId, result);
    return { result, cached: false, row };
  }

  if (!opts.force) {
    const stored = await prisma.emailVerification.findUnique({
      where: { userId_normalizedEmail: { userId, normalizedEmail: normalized } },
    });
    if (stored && isCacheFresh(stored)) {
      logVerification({ event: "email_verification_cached", email: normalized, userId, jobId, status: stored.status });
      return { result: rowToResult(stored), cached: true, row: stored };
    }
  }

  const startedAt = Date.now();
  logVerification({ event: "email_verification_started", email: normalized, userId, jobId });

  const outcome = await verifyAndNormalize(email);
  if (!outcome.ok) {
    logVerification({
      event: "email_verification_failed",
      email: normalized,
      userId,
      jobId,
      errorCode: outcome.errorCode,
      durationMs: Date.now() - startedAt,
      detail: outcome.errorMessage,
    });
    if (isTransientEngineError(outcome.errorCode)) {
      // Not persisted: an outage must not become a week-long UNKNOWN cache.
      return { result: engineFailureResult(email, outcome.errorCode, outcome.errorMessage), cached: false, row: null };
    }
    const result = engineFailureResult(email, outcome.errorCode, outcome.errorMessage);
    const row = await saveResult(userId, result);
    return { result, cached: false, row };
  }

  const result = outcome.result;
  logVerification({
    event: "email_verification_completed",
    email: normalized,
    userId,
    jobId,
    status: result.status,
    confidence: result.confidence,
    errorCode: result.errorCode ?? undefined,
    durationMs: Date.now() - startedAt,
  });
  const row = await saveResult(userId, result);
  return { result, cached: false, row };
}

/** Map a stored row back into the normalized result model. */
export function rowToResult(row: EmailVerification): VerificationResult {
  return {
    email: row.email,
    normalizedEmail: row.normalizedEmail,
    status: row.status as VerificationStatus,
    confidence: row.confidence,
    syntaxValid: row.syntaxValid,
    domainValid: row.domainValid,
    mxValid: row.mxValid,
    smtpReachable: row.smtpReachable,
    catchAll: row.catchAll,
    disposable: row.disposable,
    roleAccount: row.roleAccount,
    freeProvider: row.freeProvider,
    typoSuggestion: row.typoSuggestion,
    provider: row.provider,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    checkedAt: row.checkedAt,
    verificationVersion: row.verificationVersion,
  };
}

// ---------------------------------------------------------------------------
// Bulk enqueueing (Phase 8)
// ---------------------------------------------------------------------------

export interface EnqueueOutcome {
  total: number;
  /** Valid, normalized, deduplicated addresses accepted for this request. */
  accepted: number;
  /** Rejected by format validation. */
  invalidFormat: number;
  /** Removed because they duplicated another entry in the same request. */
  duplicates: number;
  /** Already covered by a fresh stored result (skipped unless force). */
  alreadyVerified: number;
  /** Already waiting in the queue (skipped unless force). */
  alreadyQueued: number;
  /** Newly created verification jobs. */
  queued: number;
}

/**
 * Queue background verification jobs (CSV/pasted/bulk path).
 *
 * Never verifies synchronously — jobs are picked up by the verification
 * worker (Phase 8: parse → normalize/dedupe → queue → worker → store).
 */
export async function enqueueVerifications(
  userId: string,
  emails: string[],
  opts: { force?: boolean } = {},
): Promise<EnqueueOutcome> {
  const force = opts.force === true;
  const outcome: EnqueueOutcome = {
    total: emails.length,
    accepted: 0,
    invalidFormat: 0,
    duplicates: 0,
    alreadyVerified: 0,
    alreadyQueued: 0,
    queued: 0,
  };

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of emails) {
    const normalized = normalizeOrNull(raw);
    if (!normalized) {
      outcome.invalidFormat++;
      continue;
    }
    if (seen.has(normalized)) {
      outcome.duplicates++;
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  if (unique.length === 0) {
    outcome.accepted = 0;
    return outcome;
  }

  const [freshRows, activeJobs] = await Promise.all([
    prisma.emailVerification.findMany({
      where: { userId, normalizedEmail: { in: unique } },
      select: { normalizedEmail: true, expiresAt: true },
    }),
    prisma.verificationJob.findMany({
      where: { userId, normalizedEmail: { in: unique }, status: { in: ["queued", "processing"] } },
      select: { normalizedEmail: true },
    }),
  ]);

  const freshSet = new Set(freshRows.filter((r) => isCacheFresh(r)).map((r) => r.normalizedEmail));
  const activeSet = new Set(activeJobs.map((r) => r.normalizedEmail));

  const toQueue: string[] = [];
  for (const normalized of unique) {
    if (!force && freshSet.has(normalized)) {
      outcome.alreadyVerified++;
      continue;
    }
    if (!force && activeSet.has(normalized)) {
      outcome.alreadyQueued++;
      continue;
    }
    toQueue.push(normalized);
  }

  outcome.accepted = unique.length;
  if (toQueue.length > 0) {
    // Rare races can create a second job for one address; the worker's cache
    // check makes the duplicate a cheap no-op rather than a double verification.
    await prisma.verificationJob.createMany({
      data: toQueue.map((normalized) => ({
        userId,
        email: normalized,
        normalizedEmail: normalized,
        force,
      })),
      skipDuplicates: false,
    });
    outcome.queued = toQueue.length;
    logVerification({ event: "email_verification_queued", userId, detail: `queued=${outcome.queued}` });
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Gate lookups (campaign verification policy)
// ---------------------------------------------------------------------------

/**
 * Current stored status for a batch of addresses (one query). Returns a map
 * keyed by normalized email; addresses with no stored row are simply absent —
 * callers treat absence as "never verified" (never as INVALID).
 */
export async function statusesFor(
  userId: string,
  emails: ReadonlyArray<string>,
): Promise<Map<string, EmailVerification>> {
  const normalized = Array.from(new Set(emails.map((e) => normalizeEmail(e))));
  if (normalized.length === 0) return new Map();
  const rows = await prisma.emailVerification.findMany({
    where: { userId, normalizedEmail: { in: normalized } },
  });
  return new Map(rows.map((row) => [row.normalizedEmail, row]));
}

// ---------------------------------------------------------------------------
// Stats / listing (UI + API)
// ---------------------------------------------------------------------------

export interface VerificationStats {
  total: number;
  byStatus: Record<string, number>;
  fresh: number;
  queued: number;
  processing: number;
  done: number;
  failed: number;
  lastCheckedAt: Date | null;
}

export async function verificationStats(userId: string): Promise<VerificationStats> {
  const [grouped, fresh, queued, processing, done, failed, last] = await Promise.all([
    prisma.emailVerification.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } }),
    prisma.emailVerification.count({ where: { userId, expiresAt: { gt: new Date() } } }),
    prisma.verificationJob.count({ where: { userId, status: "queued" } }),
    prisma.verificationJob.count({ where: { userId, status: "processing" } }),
    prisma.verificationJob.count({ where: { userId, status: "done" } }),
    prisma.verificationJob.count({ where: { userId, status: "failed" } }),
    prisma.emailVerification.findFirst({
      where: { userId },
      orderBy: { checkedAt: "desc" },
      select: { checkedAt: true },
    }),
  ]);

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const g of grouped) {
    byStatus[g.status] = g._count._all;
    total += g._count._all;
  }

  return {
    total,
    byStatus,
    fresh,
    queued,
    processing,
    done,
    failed,
    lastCheckedAt: last?.checkedAt ?? null,
  };
}

export interface ListQuery {
  status?: string;
  /** Substring match on the original address. */
  q?: string;
  /** Only addresses whose verification job belongs to this batch. */
  batchId?: string;
  limit: number;
  offset: number;
}

export async function listVerifications(
  userId: string,
  query: ListQuery,
): Promise<{ rows: EmailVerification[]; total: number }> {
  const where: Prisma.EmailVerificationWhereInput = {
    userId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.q ? { email: { contains: query.q, mode: "insensitive" } } : {}),
    ...(query.batchId ? { jobs: { some: { batchId: query.batchId } } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.emailVerification.findMany({
      where,
      orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
      take: Math.min(query.limit, 500),
      skip: query.offset,
    }),
    prisma.emailVerification.count({ where }),
  ]);
  return { rows, total };
}

export async function getVerificationById(
  userId: string,
  id: string,
): Promise<EmailVerification | null> {
  return prisma.emailVerification.findFirst({ where: { id, userId } });
}

/** Queue a forced re-verification for an existing record's address. */
export async function reverify(userId: string, row: EmailVerification): Promise<void> {
  await enqueueVerifications(userId, [row.normalizedEmail], { force: true });
}

export { VERIFICATION_PROVIDER, VERIFICATION_VERSION };
