/**
 * Email verification worker — DB-polling + lease-claim queue, following the
 * exact conventions of src/lib/worker.ts and src/lib/warmup/worker.ts
 * (no Redis/BullMQ exists in this project; rows ARE the queue).
 *
 * Lifecycle per job: claim → cache check → engine (normalized adapter) →
 * confidence → persist → link job to result → done.
 *   - retryable failures (timeouts, 4xx, engine down) retry with exponential
 *     backoff up to EMAIL_VERIFICATION_MAX_RETRIES, then fail the job;
 *   - permanent answers (syntax invalid, dead domain, clear rejection) never
 *     retry — they are already stored results, not failures;
 *   - one bad address can never crash the worker: every job runs inside
 *     try/catch, and the tick loop catches everything else.
 */

import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import type { Prisma } from "@prisma/client";
import { normalizeEmail } from "./normalize";
import { verifySingle } from "./service";
import { refreshBatch } from "./batch";
import { logVerification } from "./log";
import type { VerificationStatus } from "./types";

/** Lease covers a crashed worker; expired claims are reclaimable. */
const CLAIM_LEASE_MS = 10 * 60 * 1000;
/** Jobs read per tick. Kept small so a tick always finishes inside a lease. */
const BATCH_SIZE = 10;
/** Poll interval of the verification worker. */
const TICK_MS = 5_000;
/** Exponential backoff for retryable failures: 30s, 60s, 120s… cap 15 min. */
const BASE_RETRY_SECONDS = 30;
const MAX_RETRY_SECONDS = 15 * 60;

let shuttingDown = false;

function sleep(ms: number, unref = false): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Batch loops run inside the web process: never let their idle tick be
    // the reason a test runner or a shutting-down server stays alive.
    if (unref) timer.unref();
  });
}

export function backoffSeconds(attempt: number): number {
  const raw = BASE_RETRY_SECONDS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(raw, MAX_RETRY_SECONDS);
}

interface ClaimableJob {
  id: string;
  userId: string;
  email: string;
  normalizedEmail: string;
  attempts: number;
  force: boolean;
  status?: string;
  /** Null for legacy jobs — always claimable, exactly as before batches. */
  batchId?: string | null;
}

/**
 * Status a retryable job may return to: "queued" while its batch (if any)
 * still accepts claims, "cancelled" when the batch went away mid-attempt.
 * Without this, a job whose retry fires after its batch was cancelled would
 * be resurrected into a queue no worker will ever drain again.
 */
async function retryStatusFor(job: Pick<ClaimableJob, "batchId">): Promise<"queued" | "cancelled"> {
  if (!job.batchId) return "queued";
  const batch = await prisma.verificationBatch.findUnique({
    where: { id: job.batchId },
    select: { status: true },
  });
  return batch?.status === "running" ? "queued" : "cancelled";
}

/**
 * Atomically claim one job. Fails when another worker holds an unexpired
 * lease or the job is already terminal — same semantics as claimRecipient.
 * CANCELLED jobs are never claimed.
 */
export async function claimVerificationJob(job: ClaimableJob, now: Date): Promise<boolean> {
  const res = await prisma.verificationJob.updateMany({
    where: {
      id: job.id,
      OR: [
        { status: "queued", nextAttemptAt: { lte: now } },
        { status: "processing", leaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      status: "processing",
      attempts: job.attempts + 1,
      leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
    },
  });
  return res.count === 1;
}

/**
 * Cancel queued verification jobs for a user.
 * Only transitions jobs that are still in "queued" status to "cancelled".
 * Uses an atomic conditional update so that if a worker claims the job
 * (QUEUED → RUNNING) before cancellation reaches the database, the job
 * remains RUNNING and is NOT cancelled.
 */
export async function cancelVerificationJobs(userId: string): Promise<{ cancelled: number; remainingQueued: number }> {
  const now = new Date();
  // Atomically update only jobs that are currently queued.
  // If a worker changed QUEUED → RUNNING between now and the update,
  // those jobs will NOT be cancelled because the where clause requires status="queued".
  const res = await prisma.verificationJob.updateMany({
    where: {
      userId,
      status: "queued",
    },
    data: {
      status: "cancelled",
    },
  });
  const cancelled = res.count;

  // Re-count remaining queued jobs after the cancellation.
  const remaining = await prisma.verificationJob.count({
    where: { userId, status: "queued" },
  });

  return { cancelled, remainingQueued: remaining };
}

/**
 * Run one claimed job to a terminal state (or reschedule it).
 * Never throws.
 *
 * CANCELLED jobs are silently skipped — they must not be processed,
 * retried, or re‑queued.
 *
 * Note: the `job` parameter arrives with a runtime `status` field from
 * the Prisma `findMany` result.  We widen the type to include it.
 */
export async function processVerificationJob(
  job: ClaimableJob & { attempts: number; status?: string },
): Promise<"done" | "cached" | "retry" | "failed"> {
  if (job.status === "cancelled") return "done" as const;

  try {
    const outcome = await verifySingle(job.userId, job.email, {
      force: job.force,
      jobId: job.id,
    });

    if (outcome.row) {
      await prisma.verificationJob.update({
        where: { id: job.id },
        data: {
          status: "done",
          verificationId: outcome.row.id,
          lastError: null,
          leaseExpiresAt: null,
        },
      });
      return outcome.cached ? "cached" : "done";
    }

    // Transient engine failure: the result was deliberately not persisted.
    const maxAttempts = 1 + env.EMAIL_VERIFICATION_MAX_RETRIES;
    if (job.attempts < maxAttempts) {
      const retryAfterSeconds = backoffSeconds(job.attempts);
      // A batch cancelled while this attempt was in flight must not have the
      // job re-queued behind it — the claim scope would never drain that queue.
      const nextStatus = await retryStatusFor(job);
      await prisma.verificationJob.update({
        where: { id: job.id },
        data: {
          status: nextStatus,
          nextAttemptAt: new Date(Date.now() + retryAfterSeconds * 1000),
          leaseExpiresAt: null,
          lastError: outcome.result.errorMessage ?? "Verification engine unavailable",
        },
      });
      if (nextStatus === "cancelled") return "done" as const;
      logVerification({
        event: outcome.result.errorCode === "engine_timeout" ? "email_verification_timeout" : "email_verification_retry",
        email: job.normalizedEmail,
        userId: job.userId,
        jobId: job.id,
        attempt: job.attempts,
        retryAfterSeconds,
        errorCode: outcome.result.errorCode ?? undefined,
      });
      return "retry";
    }

    await prisma.verificationJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        leaseExpiresAt: null,
        lastError: outcome.result.errorMessage ?? "Verification failed",
      },
    });
    logVerification({
      event: "email_verification_failed",
      email: job.normalizedEmail,
      userId: job.userId,
      jobId: job.id,
      attempt: job.attempts,
      errorCode: outcome.result.errorCode ?? undefined,
      detail: "retry budget exhausted",
    });
    return "failed";
  } catch (err) {
    // A malformed address or an unexpected error must only fail THIS job.
    const message = err instanceof Error ? err.message : String(err);
    try {
      const retryable = job.attempts < 1 + env.EMAIL_VERIFICATION_MAX_RETRIES;
      await prisma.verificationJob.update({
        where: { id: job.id },
        data: {
          status: retryable ? await retryStatusFor(job) : "failed",
          nextAttemptAt: new Date(Date.now() + backoffSeconds(job.attempts) * 1000),
          leaseExpiresAt: null,
          lastError: message.slice(0, 300),
        },
      });
    } catch {
      // Even the failure record can fail (DB hiccup) — the tick loop survives.
    }
    logVerification({
      event: "email_verification_failed",
      email: job.normalizedEmail,
      userId: job.userId,
      jobId: job.id,
      attempt: job.attempts,
      detail: message,
    });
    return "failed";
  }
}

/**
 * Which slice of the queue one tick may claim.
 * An empty scope is the legacy/global worker: batchId-null jobs (including
 * every job that predates batches) exactly as before, plus jobs whose batch
 * is "running" so a started batch resumes even if its own loop died. A
 * pending batch is invisible to every worker — it only starts on purpose.
 */
export interface VerificationScope {
  batchId?: string;
}

function dueJobsWhere(now: Date, scope?: VerificationScope): Prisma.VerificationJobWhereInput {
  const due: Prisma.VerificationJobWhereInput = {
    OR: [
      { status: "queued", nextAttemptAt: { lte: now } },
      { status: "processing", leaseExpiresAt: { lte: now } },
    ],
  };
  if (scope?.batchId) {
    // Batch tick: ONLY this batch's jobs, and only while it is running —
    // legacy (batchId null) jobs are structurally invisible to it, and a
    // cancelled batch stops being claimed the moment its status flipped.
    return { AND: [due, { batchId: scope.batchId }, { batch: { status: "running" } }] };
  }
  return { AND: [due, { OR: [{ batchId: null }, { batch: { status: "running" } }] }] };
}

/**
 * One queue tick: claim due jobs, run them with bounded concurrency and a
 * polite delay between engine calls. Returns how many jobs were processed.
 *
 * `scope` limits the tick to a single batch (see VerificationScope); without
 * it the tick serves the legacy queue and all running batches.
 */
export async function processDueVerificationJobs(scope?: VerificationScope): Promise<number> {
  if (!env.EMAIL_VERIFICATION_ENABLED) return 0;

  const now = new Date();
  const due = await prisma.verificationJob.findMany({
    where: dueJobsWhere(now, scope),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: BATCH_SIZE,
  });
  if (due.length === 0) return 0;

  const claimed: Array<ClaimableJob & { attempts: number }> = [];
  for (const job of due) {
    if (await claimVerificationJob(job, now)) {
      claimed.push({ ...job, attempts: job.attempts + 1 });
    }
  }
  if (claimed.length === 0) return 0;

  let next = 0;
  const runOne = async (): Promise<void> => {
    while (next < claimed.length) {
      const job = claimed[next++];
      await processVerificationJob(job);
      // Space out engine calls so we never hammer mail servers (Phase 9).
      if (next < claimed.length && env.EMAIL_VERIFICATION_DELAY_MS > 0) {
        await sleep(env.EMAIL_VERIFICATION_DELAY_MS);
      }
    }
  };

  const lanes = Math.min(env.EMAIL_VERIFICATION_CONCURRENCY, claimed.length);
  await Promise.all(Array.from({ length: lanes }, runOne));
  return claimed.length;
}

/**
 * Long-running worker entry point (scripts/verification-worker.ts / PM2).
 * Never exits because of a single job or tick failure.
 */
export async function runVerificationWorker(): Promise<void> {
  console.log(
    "[verify-worker] starting — poll every %dms, concurrency=%d, timeout=%dms",
    TICK_MS,
    env.EMAIL_VERIFICATION_CONCURRENCY,
    env.EMAIL_VERIFICATION_TIMEOUT_MS,
  );
  if (!env.EMAIL_VERIFICATION_ENABLED) {
    console.warn("[verify-worker] EMAIL_VERIFICATION_ENABLED=false — idling");
  }

  process.on("SIGINT", () => {
    shuttingDown = true;
    console.log("[verify-worker] stopping…");
    setTimeout(() => process.exit(0), 500).unref();
  });
  process.on("SIGTERM", () => {
    shuttingDown = true;
    console.log("[verify-worker] stopping…");
    setTimeout(() => process.exit(0), 500).unref();
  });

  while (!shuttingDown) {
    try {
      const processed = await processDueVerificationJobs();
      if (processed > 0) console.log(`[verify-worker] processed ${processed} job(s)`);
    } catch (err) {
      console.error("[verify-worker] tick failed", err);
    }
    await sleep(TICK_MS);
  }
}

/* ------------------------------------------------------------------ *
 * Batch-scoped loop (file-first "Verify File" flow, Phase 2/3)
 * ------------------------------------------------------------------ */

/** Batches whose loop already runs in this process — one per batch. */
const activeBatchLoops = new Set<string>();

/**
 * Fire-and-forget the loop for one batch (called by the start endpoint).
 * The active set makes concurrent starts idempotent, and even two loops
 * could not double-verify anything anyway: claims are atomic lease updates,
 * so the second claimer simply loses.
 */
export function kickBatchWorker(batchId: string): void {
  if (activeBatchLoops.has(batchId)) return;
  activeBatchLoops.add(batchId);
  void runBatchWorker(batchId)
    .catch((err) => console.error(`[verify-worker] batch ${batchId} loop crashed`, err))
    .finally(() => activeBatchLoops.delete(batchId));
}

/**
 * Long-running loop over exactly one batch: claim ONLY that batch's jobs,
 * refresh its counters after every tick (which flips it to completed the
 * moment its last job lands), and exit as soon as the batch leaves
 * "running" — completed by refreshBatch, or cancelled/failed via the API.
 *
 * Resilience: if this loop dies mid-flight (process restart), the global
 * worker's claim scope still serves running batches, and calling start
 * again re-kicks this loop (idempotent). The inter-tick sleep is unref'd so
 * it never holds a process open by itself.
 */
export async function runBatchWorker(batchId: string): Promise<string> {
  if (!env.EMAIL_VERIFICATION_ENABLED) return "disabled";

  console.log(`[verify-worker] batch loop start ${batchId}`);
  let consecutiveErrors = 0;
  while (!shuttingDown) {
    try {
      const batch = await prisma.verificationBatch.findUnique({
        where: { id: batchId },
        select: { status: true },
      });
      if (!batch) return "missing";
      if (batch.status !== "running") return batch.status;

      await processDueVerificationJobs({ batchId });
      const refreshed = await refreshBatch(batchId);
      if (!refreshed) return "missing";
      if (refreshed.status !== "running") {
        console.log(`[verify-worker] batch loop end ${batchId} → ${refreshed.status}`);
        return refreshed.status;
      }
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      console.error(`[verify-worker] batch ${batchId} tick failed (${consecutiveErrors})`, err);
      // A run of failures ends this loop; nothing is lost — the global
      // worker still claims the batch's jobs, and start can re-kick us.
      if (consecutiveErrors >= 5) return "stopped";
    }
    await sleep(TICK_MS, true);
  }
  return "stopped";
}

/** Statuses currently stored for one address — used by tests and tooling. */
export async function storedStatus(
  userId: string,
  email: string,
): Promise<VerificationStatus | null> {
  const row = await prisma.emailVerification.findUnique({
    where: { userId_normalizedEmail: { userId, normalizedEmail: normalizeEmail(email) } },
    select: { status: true },
  });
  return (row?.status as VerificationStatus) ?? null;
}