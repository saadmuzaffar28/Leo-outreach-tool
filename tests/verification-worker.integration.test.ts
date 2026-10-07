/**
 * Email verification worker integration tests — real Postgres, engine faked.
 *
 * The worker is a DB-polling lease-claim queue (no Redis in this project):
 * rows ARE the queue. These tests exercise claim atomicity, the
 * done/cached/retry/failed lifecycle, backoff scheduling and the multi-job
 * tick — the parts that a mock DB could never prove.
 *
 * Only the engine's `verifyAndNormalize` is faked, exactly like the send
 * worker's SMTP layer is faked in other suites.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestDatabase, stopTestDatabase } from "./helpers/test-db";
import { createUser } from "./helpers/fixtures";
import { normalizeAfterShipResult } from "@/lib/verification/aftership-adapter";
import type { VerificationResult } from "@/lib/verification/types";
import type { PrismaClient } from "@prisma/client";

const verifyAndNormalize = vi.fn<
  (email: string) => Promise<
    | { ok: true; result: VerificationResult }
    | { ok: false; errorCode: string; errorMessage: string; retryable: boolean }
  >
>();

vi.mock("@/lib/verification/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/verification/engine")>();
  return { ...actual, verifyAndNormalize };
});

let prisma: PrismaClient;
let worker: typeof import("@/lib/verification/worker");
let userId: string;

function validResult(email: string): VerificationResult {
  return normalizeAfterShipResult(email, {
    email,
    reachable: "yes",
    syntax: { username: email.split("@")[0], domain: email.split("@")[1], valid: true },
    has_mx_records: true,
    disposable: false,
    role_account: false,
    free: false,
    suggestion: "",
    smtp: { host_exists: true, full_inbox: false, catch_all: false, deliverable: true, disabled: false },
    error: null,
  });
}

beforeAll(async () => {
  await startTestDatabase();
  prisma = (await import("@/lib/prisma")).prisma;
  worker = await import("@/lib/verification/worker");
  userId = (await createUser(prisma, "verif-worker@test.example")).id;
}, 300_000);

afterAll(async () => {
  await stopTestDatabase();
}, 120_000);

beforeEach(async () => {
  verifyAndNormalize.mockReset();
  await prisma.emailVerification.deleteMany({});
  await prisma.verificationJob.deleteMany({});
});

async function createJob(over: Partial<{ status: string; attempts: number; nextAttemptAt: Date; leaseExpiresAt: Date | null; email: string; force: boolean }> = {}) {
  const email = over.email ?? `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@x.com`;
  return prisma.verificationJob.create({
    data: {
      userId,
      email,
      normalizedEmail: email.toLowerCase(),
      status: over.status ?? "queued",
      attempts: over.attempts ?? 0,
      nextAttemptAt: over.nextAttemptAt ?? new Date(0),
      leaseExpiresAt: over.leaseExpiresAt ?? null,
      force: over.force ?? false,
    },
  });
}

describe("claimVerificationJob — lease-claim atomicity", () => {
  it("claims a due queued job exactly once", async () => {
    const job = await createJob();
    const now = new Date();

    const claimable = { id: job.id, userId, email: job.email, normalizedEmail: job.normalizedEmail, attempts: job.attempts, force: false };
    expect(await worker.claimVerificationJob(claimable, now)).toBe(true);
    // A second claim by another worker holding the same view is refused.
    expect(await worker.claimVerificationJob(claimable, now)).toBe(false);

    const row = await prisma.verificationJob.findUnique({ where: { id: job.id } });
    expect(row?.status).toBe("processing");
    expect(row?.attempts).toBe(1);
    expect(row?.leaseExpiresAt).not.toBeNull();
  });

  it("re-claims a job whose lease expired (crashed worker recovery)", async () => {
    const job = await createJob({
      status: "processing",
      attempts: 1,
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    const claimable = { id: job.id, userId, email: job.email, normalizedEmail: job.normalizedEmail, attempts: job.attempts, force: false };
    expect(await worker.claimVerificationJob(claimable, new Date())).toBe(true);
  });

  it("never claims a terminal job", async () => {
    for (const status of ["done", "failed"]) {
      const job = await createJob({ status });
      const claimable = { id: job.id, userId, email: job.email, normalizedEmail: job.normalizedEmail, attempts: job.attempts, force: false };
      expect(await worker.claimVerificationJob(claimable, new Date())).toBe(false);
    }
  });
});

describe("processVerificationJob — lifecycle", () => {
  it("marks a successfully verified job done and links the stored result", async () => {
    verifyAndNormalize.mockResolvedValue({ ok: true, result: validResult("done@x.com") });
    const job = await createJob({ email: "done@x.com" });

    const result = await worker.processVerificationJob({
      id: job.id, userId, email: job.email, normalizedEmail: job.normalizedEmail, attempts: 1, force: false,
    });

    expect(result).toBe("done");
    const row = await prisma.verificationJob.findUnique({ where: { id: job.id } });
    expect(row?.status).toBe("done");
    expect(row?.leaseExpiresAt).toBeNull();
    expect(row?.verificationId).not.toBeNull();
    const stored = await prisma.emailVerification.findUnique({ where: { id: row!.verificationId! } });
    expect(stored?.status).toBe("VALID");
  });

  it("resolves from cache and still terminates the job", async () => {
    // A fresh stored result exists; the engine would answer, but must not be asked.
    await prisma.emailVerification.create({
      data: {
        userId, email: "cached@x.com", normalizedEmail: "cached@x.com", status: "VALID",
        confidence: 100, syntaxValid: true, domainValid: true, mxValid: true, smtpReachable: true,
        provider: "aftership", verificationVersion: "1.0.0", expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    verifyAndNormalize.mockResolvedValue({ ok: true, result: validResult("cached@x.com") });

    const job = await createJob({ email: "cached@x.com" });
    const result = await worker.processVerificationJob({
      id: job.id, userId, email: job.email, normalizedEmail: job.normalizedEmail, attempts: 1, force: false,
    });

    expect(result).toBe("cached");
    expect(verifyAndNormalize).not.toHaveBeenCalled();
    expect((await prisma.verificationJob.findUnique({ where: { id: job.id } }))?.status).toBe("done");
  });

  it("retries a transient engine failure with backoff, then fails at the budget limit", async () => {
    verifyAndNormalize.mockResolvedValue({
      ok: false, errorCode: "service_unavailable", errorMessage: "engine down", retryable: true,
    });

    const job = await createJob({ email: "retry@x.com" });
    const attempt1 = await worker.processVerificationJob({
      id: job.id, userId, email: job.email, normalizedEmail: job.normalizedEmail, attempts: 1, force: false,
    });
    expect(attempt1).toBe("retry");
    let row = await prisma.verificationJob.findUnique({ where: { id: job.id } });
    expect(row?.status).toBe("queued"); // rescheduled, not failed
    expect(row?.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 20_000); // ~30s backoff
    expect(row?.lastError).toContain("engine down");

    const attempt2 = await worker.processVerificationJob({
      id: job.id, userId, email: job.email, normalizedEmail: job.normalizedEmail, attempts: 2, force: false,
    });
    expect(attempt2).toBe("retry");

    const attempt3 = await worker.processVerificationJob({
      id: job.id, userId, email: job.email, normalizedEmail: job.normalizedEmail, attempts: 3, force: false,
    });
    expect(attempt3).toBe("failed");
    row = await prisma.verificationJob.findUnique({ where: { id: job.id } });
    expect(row?.status).toBe("failed");
    expect(row?.leaseExpiresAt).toBeNull();
    expect(row?.lastError).toContain("engine down");
  });

  it("survives an unexpected engine throw and reschedules (never crashes the worker)", async () => {
    verifyAndNormalize.mockRejectedValue(new Error("boom"));
    const job = await createJob({ email: "throw@x.com" });

    const result = await worker.processVerificationJob({
      id: job.id, userId, email: job.email, normalizedEmail: job.normalizedEmail, attempts: 1, force: false,
    });

    expect(result).toBe("failed");
    const row = await prisma.verificationJob.findUnique({ where: { id: job.id } });
    expect(row?.status).toBe("queued"); // retryable catch path
    expect(row?.lastError).toContain("boom");
  });
});

describe("processDueVerificationJobs — the tick", () => {
  it("claims and completes a small batch, storing every result", async () => {
    verifyAndNormalize.mockImplementation(async (email) => ({ ok: true, result: validResult(email) }));

    for (const email of ["t1@x.com", "t2@y.com", "t3@z.com"]) {
      await prisma.verificationJob.create({
        data: { userId, email, normalizedEmail: email, status: "queued", nextAttemptAt: new Date(0) },
      });
    }

    const processed = await worker.processDueVerificationJobs();
    expect(processed).toBe(3);

    const jobs = await prisma.verificationJob.findMany({ where: { userId } });
    expect(jobs.every((j) => j.status === "done")).toBe(true);
    const stored = await prisma.emailVerification.findMany({ where: { userId } });
    expect(stored).toHaveLength(3);
    expect(stored.map((r) => r.status)).toEqual(["VALID", "VALID", "VALID"]);
  }, 20_000);

  it("only picks up jobs that are due", async () => {
    verifyAndNormalize.mockImplementation(async (email) => ({ ok: true, result: validResult(email) }));
    // One due now, one scheduled an hour out.
    await createJob({ email: "now@x.com" });
    await createJob({ email: "later@x.com", nextAttemptAt: new Date(Date.now() + 3_600_000) });

    const processed = await worker.processDueVerificationJobs();
    expect(processed).toBe(1);
    const done = await prisma.emailVerification.findMany({ where: { userId } });
    expect(done.map((r) => r.normalizedEmail)).toEqual(["now@x.com"]);
  });

  it("returns 0 when nothing is due", async () => {
    await createJob({ status: "done" });
    expect(await worker.processDueVerificationJobs()).toBe(0);
  });
});