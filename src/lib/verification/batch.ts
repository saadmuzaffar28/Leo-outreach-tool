/**
 * File-first verification batches (Phase 2/3).
 *
 * A batch is one uploaded file the user asked to verify:
 *
 *   upload → parse / validate / dedupe only (creates NOTHING)
 *     → POST /api/email-verification/batches            ("Verify File")
 *         batch + jobs born together in ONE transaction, status "pending"
 *     → POST /api/email-verification/batches/:id/start
 *         atomic pending→running, then a batch-scoped worker loop
 *     → POST /api/email-verification/batches/:id/cancel
 *         atomic pending|running→cancelled, queued jobs cancelled with it
 *
 * Invariants this module owns:
 *  - `userId` is an ownership label, never a relation (see schema docs):
 *    every helper here takes the session user and filters on it, so foreign
 *    batches 404 without ever trusting a client-supplied id.
 *  - Counters are NEVER incremented in place. `refreshBatch` recomputes every
 *    counter from the job/result tables in a single UPDATE whose scalar
 *    subqueries share one snapshot — no read-modify-write, so two ticks
 *    landing at once cannot drift the numbers. Every read of a batch goes
 *    through it, which makes the row a live view of its jobs.
 *  - Status moves only along `canTransition` arrows, and each arrow is a
 *    guarded `updateMany` (pending→running, pending|running→cancelled,
 *    running→completed): a race can lose a transition, never perform an
 *    illegal or duplicated one.
 *  - Creation is the single transactional moment. If any job insert fails —
 *    e.g. a userId that does not exist in User, which batches cannot detect
 *    because they carry no user relation — the batch insert rolls back with
 *    it. No orphan batches, no orphan jobs.
 */

import { prisma } from "@/lib/prisma";
import type { VerificationBatch } from "@prisma/client";
import { normalizeOrNull } from "./normalize";

/** Every batch state, in lifecycle order. */
export const BATCH_STATUSES = ["pending", "running", "completed", "cancelled", "failed"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/**
 * Allowed state transitions. pending can start or be abandoned; running can
 * complete or be abandoned; terminal states never move again.
 */
const ALLOWED_TRANSITIONS: Record<BatchStatus, readonly BatchStatus[]> = {
  pending: ["running", "cancelled", "failed"],
  running: ["completed", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};

/** Pure state-machine check — exported so tests can pin the whole matrix. */
export function canTransition(from: string, to: string): boolean {
  return ALLOWED_TRANSITIONS[from as BatchStatus]?.includes(to as BatchStatus) ?? false;
}

/** Thrown by batch helpers; routes map `code` onto an HTTP status. */
export class BatchError extends Error {
  constructor(
    message: string,
    readonly code: "NO_VALID_EMAILS",
  ) {
    super(message);
    this.name = "BatchError";
  }
}

/** The session user's batch, or null — for foreign/unknown ids alike. */
export async function getOwnedBatch(userId: string, batchId: string): Promise<VerificationBatch | null> {
  return prisma.verificationBatch.findFirst({ where: { id: batchId, userId } });
}

// ---------------------------------------------------------------------------
// Creation (the ONLY place a batch and its jobs come into existence)
// ---------------------------------------------------------------------------

export interface CreateBatchInput {
  filename: string;
  /** Already-parsed addresses from the upload step — never the raw file. */
  emails: string[];
  /** Re-verify even when a fresh cached result exists. */
  force?: boolean;
}

export interface CreateBatchOutcome {
  batch: VerificationBatch;
  /** Jobs created: every valid, deduplicated address in the file. */
  created: number;
  /** Rejected by format validation (no job created for these). */
  invalidFormat: number;
  /** Duplicated another entry in the same file (no job created for these). */
  duplicates: number;
}

/**
 * Create a batch and its jobs atomically. The batch is born "pending":
 * nothing is verified here, no engine is touched, no worker is started.
 *
 * Every valid, deduplicated address becomes exactly one job tagged with this
 * batch's id. Unlike the legacy bulk enqueue there is no cache/active-queue
 * skipping: a batch must mirror its file 1:1 (batch.total === addresses in
 * the file), and the worker's cache check already makes an already-verified
 * address a cheap no-op when the job runs.
 */
export async function createVerificationBatch(userId: string, input: CreateBatchInput): Promise<CreateBatchOutcome> {
  const force = input.force === true;
  const filename = input.filename.trim();

  let invalidFormat = 0;
  let duplicates = 0;
  const unique: Array<{ email: string; normalizedEmail: string }> = [];
  const seen = new Set<string>();
  for (const raw of input.emails) {
    const normalized = normalizeOrNull(raw);
    if (normalized === null) {
      invalidFormat += 1;
      continue;
    }
    if (seen.has(normalized)) {
      duplicates += 1;
      continue;
    }
    seen.add(normalized);
    unique.push({ email: raw.trim(), normalizedEmail: normalized });
  }

  if (unique.length === 0) {
    throw new BatchError("No valid addresses to verify", "NO_VALID_EMAILS");
  }

  const batch = await prisma.$transaction(async (tx) => {
    const created = await tx.verificationBatch.create({
      data: {
        userId,
        filename,
        total: unique.length,
        // Correct by construction: all jobs are queued, none ran yet.
        queued: unique.length,
      },
    });
    await tx.verificationJob.createMany({
      data: unique.map((row) => ({
        userId,
        email: row.email,
        normalizedEmail: row.normalizedEmail,
        batchId: created.id,
        force,
      })),
    });
    return created;
  });

  return { batch, created: unique.length, invalidFormat, duplicates };
}

// ---------------------------------------------------------------------------
// Counters + completion (one atomic recompute, never an increment)
// ---------------------------------------------------------------------------

/**
 * Recompute every counter from the job/result tables and flip a drained
 * running batch to completed — both in single statements.
 *
 * Why subqueries inside one UPDATE: they share that statement's snapshot, so
 * concurrent refreshes overwrite with complete, self-consistent pictures
 * instead of interleaving read-modify-write increments that drift. Why the
 * completion flip is a second statement with its own guard: "no job is
 * queued or processing" can only become true, never false again (terminal
 * job states are absorbing and batches never gain jobs), so evaluating it
 * after the counters cannot produce a premature completion.
 *
 * Returns the refreshed row, or null when the batch vanished.
 */
export async function refreshBatch(batchId: string): Promise<VerificationBatch | null> {
  await prisma.$executeRaw`
    UPDATE "VerificationBatch" SET
      "total"     = (SELECT COUNT(*) FROM "VerificationJob" WHERE "batchId" = ${batchId}),
      "queued"    = (SELECT COUNT(*) FROM "VerificationJob" WHERE "batchId" = ${batchId} AND "status" = 'queued'),
      "running"   = (SELECT COUNT(*) FROM "VerificationJob" WHERE "batchId" = ${batchId} AND "status" = 'processing'),
      "completed" = (SELECT COUNT(*) FROM "VerificationJob" WHERE "batchId" = ${batchId} AND "status" IN ('done', 'failed', 'cancelled')),
      "failed"    = (SELECT COUNT(*) FROM "VerificationJob" WHERE "batchId" = ${batchId} AND "status" = 'failed'),
      "valid"     = (SELECT COUNT(*) FROM "EmailVerification" ev WHERE ev."status" = 'VALID'
                       AND EXISTS (SELECT 1 FROM "VerificationJob" j WHERE j."verificationId" = ev."id" AND j."batchId" = ${batchId})),
      "invalid"   = (SELECT COUNT(*) FROM "EmailVerification" ev WHERE ev."status" = 'INVALID'
                       AND EXISTS (SELECT 1 FROM "VerificationJob" j WHERE j."verificationId" = ev."id" AND j."batchId" = ${batchId})),
      "risky"     = (SELECT COUNT(*) FROM "EmailVerification" ev WHERE ev."status" = 'RISKY'
                       AND EXISTS (SELECT 1 FROM "VerificationJob" j WHERE j."verificationId" = ev."id" AND j."batchId" = ${batchId})),
      "catchAll"  = (SELECT COUNT(*) FROM "EmailVerification" ev WHERE ev."status" = 'CATCH_ALL'
                       AND EXISTS (SELECT 1 FROM "VerificationJob" j WHERE j."verificationId" = ev."id" AND j."batchId" = ${batchId})),
      "unknown"   = (SELECT COUNT(*) FROM "EmailVerification" ev WHERE ev."status" = 'UNKNOWN'
                       AND EXISTS (SELECT 1 FROM "VerificationJob" j WHERE j."verificationId" = ev."id" AND j."batchId" = ${batchId}))
    WHERE "id" = ${batchId}`;

  // running → completed only, and only while no job is left to claim. A
  // cancelled/failed batch is terminal and must never be resurrected here.
  await prisma.$executeRaw`
    UPDATE "VerificationBatch" SET "status" = 'completed', "completedAt" = ${new Date()}
    WHERE "id" = ${batchId} AND "status" = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM "VerificationJob"
        WHERE "batchId" = ${batchId} AND "status" IN ('queued', 'processing')
      )`;

  return prisma.verificationBatch.findUnique({ where: { id: batchId } });
}

// ---------------------------------------------------------------------------
// Listing / viewing (always through refreshBatch, so counters are live)
// ---------------------------------------------------------------------------

export async function listVerificationBatches(userId: string, limit = 20): Promise<VerificationBatch[]> {
  const batches = await prisma.verificationBatch.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(Math.trunc(limit) || 20, 1), 100),
  });
  const refreshed = await Promise.all(batches.map((batch) => refreshBatch(batch.id)));
  return refreshed.map((row, i) => row ?? batches[i]);
}

// ---------------------------------------------------------------------------
// Transitions (start / cancel) — ownership + atomic guarded updateMany
// ---------------------------------------------------------------------------

export type StartBatchResult =
  | { ok: true; batch: VerificationBatch; alreadyRunning: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; batch: VerificationBatch };

/**
 * pending → running, atomically. Exactly one of two concurrent starters
 * wins the guarded update; the loser is answered as `alreadyRunning`.
 * Running is idempotent on purpose: calling start again re-kicks the
 * (guarded) batch loop, which is how a batch resumes after a process
 * restart. Terminal batches conflict (409).
 */
export async function startVerificationBatch(userId: string, batchId: string): Promise<StartBatchResult> {
  const owned = await getOwnedBatch(userId, batchId);
  if (!owned) return { ok: false, reason: "not_found" };

  if (owned.status === "pending") {
    const flipped = await prisma.verificationBatch.updateMany({
      where: { id: batchId, userId, status: "pending" },
      data: { status: "running", startedAt: new Date() },
    });
    if (flipped.count === 1) {
      const batch = await refreshBatch(batchId);
      return batch ? { ok: true, batch, alreadyRunning: false } : { ok: false, reason: "not_found" };
    }
    // Lost the race — re-read and answer from the fresh state.
    const fresh = await getOwnedBatch(userId, batchId);
    if (!fresh) return { ok: false, reason: "not_found" };
    if (fresh.status === "running") return { ok: true, batch: fresh, alreadyRunning: true };
    return { ok: false, reason: "conflict", batch: fresh };
  }

  if (owned.status === "running") return { ok: true, batch: owned, alreadyRunning: true };
  return { ok: false, reason: "conflict", batch: owned };
}

export type CancelBatchResult =
  | { ok: true; batch: VerificationBatch }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; batch: VerificationBatch };

/**
 * pending|running → cancelled, atomically, and cancel every job still
 * waiting in the queue. Jobs already claimed finish their current attempt —
 * the claim scope refuses new claims the instant the batch left "running",
 * and the worker's retry path re-queues into "cancelled" instead of "queued"
 * when the batch is gone, so nothing can leak back into the queue.
 */
export async function cancelVerificationBatch(userId: string, batchId: string): Promise<CancelBatchResult> {
  const owned = await getOwnedBatch(userId, batchId);
  if (!owned) return { ok: false, reason: "not_found" };
  if (owned.status !== "pending" && owned.status !== "running") {
    return { ok: false, reason: "conflict", batch: owned };
  }

  const flipped = await prisma.verificationBatch.updateMany({
    where: { id: batchId, userId, status: { in: ["pending", "running"] } },
    data: { status: "cancelled", completedAt: new Date() },
  });
  if (flipped.count === 0) {
    const fresh = await getOwnedBatch(userId, batchId);
    if (!fresh) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "conflict", batch: fresh };
  }

  // Only still-queued jobs flip; a job mid-attempt keeps running out its
  // lease and lands as done/failed, counted by the refresh below.
  await prisma.verificationJob.updateMany({
    where: { batchId, status: "queued" },
    data: { status: "cancelled" },
  });

  const batch = await refreshBatch(batchId);
  return batch ? { ok: true, batch } : { ok: false, reason: "not_found" };
}
