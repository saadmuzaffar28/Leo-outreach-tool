/**
 * File-first verification batch tests (Phase 2/3) — real Postgres.
 *
 * Same pattern as verification-api.integration.test.ts: session mocked,
 * engine mocked, everything else (validation, transactions, FKs, claim
 * queries, ownership scoping) real. The start endpoint's in-process loop is
 * spied instead of executed so transitions stay deterministic; the loop
 * itself is exercised directly via runBatchWorker/processDueVerificationJobs.
 *
 * Covered: batch creation, authenticated/unauthenticated access, cross-user
 * isolation on view/start/cancel/jobs/export, batchId linkage, dedupe,
 * invalid exclusion, upload-creates-zero-jobs, Verify-File-creates-jobs,
 * legacy (batchId null) jobs untouched and unclaimed by batch ticks, start
 * ownership, status transitions, counters, and transaction rollback.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestDatabase, stopTestDatabase } from "./helpers/test-db";
import { createUser } from "./helpers/fixtures";
import { normalizeAfterShipResult } from "@/lib/verification/aftership-adapter";
import { parseEmailList } from "@/lib/verification/normalize";
import type { VerificationResult } from "@/lib/verification/types";
import type { PrismaClient } from "@prisma/client";

const getSession = vi.fn<() => Promise<{ sub: string; email: string } | null>>();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession };
});

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

// The start endpoint fires an in-process batch loop; tests assert the kick
// happened instead of letting it race the assertions. Everything the loop
// does is tested directly below through the real (spread) worker functions.
const kickBatchWorker = vi.fn<(batchId: string) => void>();
vi.mock("@/lib/verification/worker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/verification/worker")>();
  return { ...actual, kickBatchWorker };
});

let prisma: PrismaClient;
let ownerId: string;
let strangerId: string;

const ORIGIN = "http://localhost:3000"; // == APP_URL in vitest.config.ts

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

const json = async (res: Response): Promise<any> => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

function postReq(body: unknown): Request {
  return new Request(ORIGIN, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authed(sub: string) {
  getSession.mockResolvedValue({ sub, email: "x@test.example" });
}

/** POST /batches — the "Verify File" action. Assumes authed() was called. */
async function createBatch(emails: string[], filename = "leads.csv"): Promise<string> {
  const { POST } = await import("@/app/api/email-verification/batches/route");
  const res = await POST(postReq({ filename, emails }));
  expect(res.status).toBe(201);
  return (await json(res)).batchId;
}

async function startBatch(batchId: string): Promise<Response> {
  const { POST } = await import("@/app/api/email-verification/batches/[batchId]/start/route");
  return POST(postReq({}), { params: { batchId } });
}

async function cancelBatch(batchId: string): Promise<Response> {
  const { POST } = await import("@/app/api/email-verification/batches/[batchId]/cancel/route");
  return POST(postReq({}), { params: { batchId } });
}

async function viewBatch(batchId: string): Promise<Response> {
  const { GET } = await import("@/app/api/email-verification/batches/[batchId]/route");
  return GET(new Request(ORIGIN), { params: { batchId } });
}

async function batchJobs(batchId: string): Promise<Response> {
  const { GET } = await import("@/app/api/email-verification/batches/[batchId]/jobs/route");
  return GET(new Request(ORIGIN), { params: { batchId } });
}

/** A pre-batch queue row: batchId stays null forever, exactly like production. */
async function seedLegacyJob(email: string) {
  return prisma.verificationJob.create({
    data: { userId: ownerId, email, normalizedEmail: email.toLowerCase() },
  });
}

beforeAll(async () => {
  await startTestDatabase();
  prisma = (await import("@/lib/prisma")).prisma;
  ownerId = (await createUser(prisma, "batch-owner@test.example")).id;
  strangerId = (await createUser(prisma, "batch-stranger@test.example")).id;
}, 300_000);

afterAll(async () => {
  await stopTestDatabase();
}, 120_000);

beforeEach(async () => {
  getSession.mockReset();
  verifyAndNormalize.mockReset();
  kickBatchWorker.mockReset();
  await prisma.verificationJob.deleteMany({});
  await prisma.verificationBatch.deleteMany({});
  await prisma.emailVerification.deleteMany({});
});

// ---------------------------------------------------------------------------

describe("POST /api/email-verification/batches — creation", () => {
  it("refuses unauthenticated callers", async () => {
    getSession.mockResolvedValue(null);
    const { POST } = await import("@/app/api/email-verification/batches/route");
    const res = await POST(postReq({ filename: "leads.csv", emails: ["a@x.com"] }));
    expect(res.status).toBe(403);
  });

  it("rejects a foreign origin", async () => {
    authed(ownerId);
    const { POST } = await import("@/app/api/email-verification/batches/route");
    const res = await POST(
      new Request(ORIGIN, {
        method: "POST",
        headers: { origin: "http://evil.test", "content-type": "application/json" },
        body: JSON.stringify({ filename: "leads.csv", emails: ["a@x.com"] }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("creates one job per valid, deduplicated address and links them to the batch", async () => {
    authed(ownerId);
    const { POST } = await import("@/app/api/email-verification/batches/route");
    const res = await POST(
      postReq({
        filename: "  leads.csv  ",
        emails: ["a@x.com", "A@X.com", "not-an-email", "b@y.com", "b@y.com"],
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);

    expect(body.batchId).toBeTypeOf("string");
    expect(body.created).toBe(2);
    expect(body.invalidFormat).toBe(1);
    expect(body.duplicates).toBe(2);
    expect(body.batch.filename).toBe("leads.csv"); // trimmed
    expect(body.batch.total).toBe(2);
    expect(body.batch.queued).toBe(2);

    // Born pending: nothing is claimed, nothing started.
    expect(body.batch.status).toBe("pending");
    expect(body.batch.startedAt).toBeNull();

    const jobs = await prisma.verificationJob.findMany({ where: { batchId: body.batchId } });
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => j.normalizedEmail))).toEqual(new Set(["a@x.com", "b@y.com"]));
    for (const job of jobs) {
      expect(job.batchId).toBe(body.batchId); // correct linkage
      expect(job.userId).toBe(ownerId); // session-derived owner
      expect(job.status).toBe("queued");
      expect(job.attempts).toBe(0);
    }

    // The invalid address and the duplicates never became jobs.
    expect(await prisma.verificationJob.count({ where: { normalizedEmail: "not-an-email" } })).toBe(0);
    expect(await prisma.verificationJob.count()).toBe(2);
  });

  it("the upload/parse step creates zero batches and zero jobs; Verify File creates them", async () => {
    // The UI's upload step calls parseEmailList — parsing must create nothing.
    const parsed = parseEmailList("email\na@x.com\nA@x.com\nnot-an-email\nb@y.com");
    expect(parsed.emails).toEqual(["a@x.com", "b@y.com"]);
    expect(parsed.duplicates).toBe(1);
    expect(parsed.invalid).toBe(1);
    expect(await prisma.verificationBatch.count()).toBe(0);
    expect(await prisma.verificationJob.count()).toBe(0);

    // Only the Verify File POST materializes them — from the PARSED list.
    authed(ownerId);
    const batchId = await createBatch(parsed.emails);
    expect(await prisma.verificationBatch.count()).toBe(1);
    expect(await prisma.verificationJob.count()).toBe(2);
    expect(await prisma.verificationJob.count({ where: { batchId } })).toBe(2);
  });

  it("rejects a batch with no valid addresses and creates nothing", async () => {
    authed(ownerId);
    const { POST } = await import("@/app/api/email-verification/batches/route");
    const noValid = await POST(postReq({ filename: "x.csv", emails: ["nope", "also bad"] }));
    expect(noValid.status).toBe(400);
    const empty = await POST(postReq({ filename: "x.csv", emails: [] }));
    expect(empty.status).toBe(400);
    expect(await prisma.verificationBatch.count()).toBe(0);
    expect(await prisma.verificationJob.count()).toBe(0);
  });

  it("rolls back the whole batch when a job insert fails (ghost userId)", async () => {
    const { createVerificationBatch } = await import("@/lib/verification/batch");
    const ghost = "ghost-user-that-is-not-in-user-table";
    await expect(
      createVerificationBatch(ghost, { filename: "ghost.csv", emails: ["a@x.com", "b@y.com"] }),
    ).rejects.toThrow();
    // The batch row must have rolled back with the failing job insert.
    expect(await prisma.verificationBatch.count({ where: { userId: ghost } })).toBe(0);
    expect(await prisma.verificationJob.count({ where: { userId: ghost } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("batch endpoints — authentication and ownership", () => {
  it("refuses unauthenticated view, start, cancel and jobs reads", async () => {
    getSession.mockResolvedValue(null);
    const { GET: view } = await import("@/app/api/email-verification/batches/[batchId]/route");
    const { GET: jobs } = await import("@/app/api/email-verification/batches/[batchId]/jobs/route");
    const { POST: start } = await import("@/app/api/email-verification/batches/[batchId]/start/route");
    const { POST: cancel } = await import("@/app/api/email-verification/batches/[batchId]/cancel/route");

    expect((await view(new Request(ORIGIN), { params: { batchId: "any" } })).status).toBe(403);
    expect((await jobs(new Request(ORIGIN), { params: { batchId: "any" } })).status).toBe(403);
    expect((await start(postReq({}), { params: { batchId: "any" } })).status).toBe(403);
    expect((await cancel(postReq({}), { params: { batchId: "any" } })).status).toBe(403);
  });

  it("another user's batch 404s on view, start, cancel, jobs and export — and stays untouched", async () => {
    authed(ownerId);
    const batchId = await createBatch(["a@x.com", "b@y.com"]);

    authed(strangerId);
    expect((await viewBatch(batchId)).status).toBe(404);
    expect((await startBatch(batchId)).status).toBe(404);
    expect((await cancelBatch(batchId)).status).toBe(404);
    expect((await batchJobs(batchId)).status).toBe(404);
    const { GET: exportGet } = await import("@/app/api/email-verification/export/route");
    const exportRes = await exportGet(
      new Request(`${ORIGIN}/api/email-verification/export?batchId=${batchId}`),
    );
    expect(exportRes.status).toBe(404);

    // Nothing happened to the owner's batch or its jobs, and no loop kicked.
    const row = await prisma.verificationBatch.findUnique({ where: { id: batchId } });
    expect(row?.status).toBe("pending");
    expect(row?.userId).toBe(ownerId);
    expect(kickBatchWorker).not.toHaveBeenCalled();
    const jobs = await prisma.verificationJob.findMany({ where: { batchId } });
    expect(jobs.every((j) => j.status === "queued" && j.attempts === 0)).toBe(true);
  });

  it("start: pending → running atomically, kicks the batch loop, and is idempotent", async () => {
    authed(ownerId);
    const batchId = await createBatch(["a@x.com"]);

    const first = await json(await startBatch(batchId));
    expect(first.ok).toBe(true);
    expect(first.alreadyRunning).toBe(false);
    expect(first.batch.status).toBe("running");
    expect(first.batch.startedAt).not.toBeNull();
    expect(kickBatchWorker).toHaveBeenCalledTimes(1);
    expect(kickBatchWorker).toHaveBeenCalledWith(batchId);

    // Second start: no new transition, but the (guarded) loop is re-kicked.
    const second = await json(await startBatch(batchId));
    expect(second.ok).toBe(true);
    expect(second.alreadyRunning).toBe(true);
    expect(kickBatchWorker).toHaveBeenCalledTimes(2);

    const row = await prisma.verificationBatch.findUnique({ where: { id: batchId } });
    expect(row?.status).toBe("running");
  });

  it("cancel: pending|running → cancelled, queued jobs cancelled with it, terminal afterwards", async () => {
    authed(ownerId);
    const batchId = await createBatch(["a@x.com", "b@y.com"]);
    expect((await json(await startBatch(batchId))).batch.status).toBe("running");

    const cancelled = await json(await cancelBatch(batchId));
    expect(cancelled.ok).toBe(true);
    expect(cancelled.batch.status).toBe("cancelled");
    expect(cancelled.batch.completedAt).not.toBeNull();

    const jobs = await prisma.verificationJob.findMany({ where: { batchId } });
    expect(jobs.every((j) => j.status === "cancelled")).toBe(true);
    const row = await prisma.verificationBatch.findUnique({ where: { id: batchId } });
    expect(row?.queued).toBe(0);
    expect(row?.completed).toBe(2);

    // No claim can ever happen after cancellation — scoped or global.
    const { processDueVerificationJobs } = await import("@/lib/verification/worker");
    expect(await processDueVerificationJobs({ batchId })).toBe(0);
    expect(await processDueVerificationJobs()).toBe(0);

    // Terminal: neither cancel nor start may move it again.
    expect((await cancelBatch(batchId)).status).toBe(409);
    const startAgain = await startBatch(batchId);
    expect(startAgain.status).toBe(409);
    expect((await json(startAgain)).status).toBe("cancelled");
    expect(kickBatchWorker).toHaveBeenCalledTimes(1); // only the very first start
  });

  it("start of a completed batch conflicts with 409", async () => {
    authed(ownerId);
    const batchId = await createBatch(["done@x.com"]);
    await startBatch(batchId);
    verifyAndNormalize.mockImplementation(async (email) => ({ ok: true, result: validResult(email) }));
    const { runBatchWorker } = await import("@/lib/verification/worker");
    expect(await runBatchWorker(batchId)).toBe("completed");

    const res = await startBatch(batchId);
    expect(res.status).toBe(409);
    expect((await json(res)).status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------

describe("worker scoping — legacy queue vs batch jobs", () => {
  it("batch creation never touches pre-existing batchId-null jobs", async () => {
    const legacy = await seedLegacyJob("legacy@old.com");
    expect(legacy.batchId).toBeNull();
    expect(legacy.status).toBe("queued");

    authed(ownerId);
    const batchId = await createBatch(["a@x.com", "b@y.com"]);

    const after = await prisma.verificationJob.findUnique({ where: { id: legacy.id } });
    expect(after).toMatchObject({
      status: "queued",
      batchId: null,
      attempts: 0,
      userId: ownerId,
    });
    // The new jobs are all batch-tagged; the legacy row is not among them.
    const jobs = await prisma.verificationJob.findMany({ where: { batchId } });
    expect(jobs).toHaveLength(2);
    expect(jobs.some((j) => j.id === legacy.id)).toBe(false);
  });

  it("global tick serves the legacy queue but never a pending batch", async () => {
    const legacy = await seedLegacyJob("legacy@old.com");
    authed(ownerId);
    const batchId = await createBatch(["a@x.com", "b@y.com"]);
    verifyAndNormalize.mockImplementation(async (email) => ({ ok: true, result: validResult(email) }));

    const { processDueVerificationJobs } = await import("@/lib/verification/worker");
    const processed = await processDueVerificationJobs();
    expect(processed).toBe(1); // the legacy job only
    expect(verifyAndNormalize).toHaveBeenCalledTimes(1);
    expect(verifyAndNormalize.mock.calls[0][0]).toBe("legacy@old.com");

    const legacyAfter = await prisma.verificationJob.findUnique({ where: { id: legacy.id } });
    expect(legacyAfter?.status).toBe("done");
    expect(legacyAfter?.batchId).toBeNull();

    // The pending batch's jobs were invisible to the global worker.
    const jobs = await prisma.verificationJob.findMany({ where: { batchId } });
    expect(jobs.every((j) => j.status === "queued" && j.attempts === 0)).toBe(true);
  });

  it("batch tick consumes only its own batch — never legacy jobs or another batch", async () => {
    const legacy = await seedLegacyJob("legacy@old.com");
    authed(ownerId);
    const batchA = await createBatch(["a@x.com", "b@y.com"], "a.csv");
    const batchB = await createBatch(["c@z.com"], "b.csv");
    await startBatch(batchA); // only A is running; B stays pending
    verifyAndNormalize.mockImplementation(async (email) => ({ ok: true, result: validResult(email) }));

    const { processDueVerificationJobs } = await import("@/lib/verification/worker");
    const processed = await processDueVerificationJobs({ batchId: batchA });
    expect(processed).toBe(2);
    expect(verifyAndNormalize).toHaveBeenCalledTimes(2);

    const aJobs = await prisma.verificationJob.findMany({ where: { batchId: batchA } });
    expect(aJobs.every((j) => j.status === "done" && j.verificationId !== null)).toBe(true);

    // Untouched by the batch tick:
    const legacyAfter = await prisma.verificationJob.findUnique({ where: { id: legacy.id } });
    expect(legacyAfter?.status).toBe("queued");
    expect(legacyAfter?.attempts).toBe(0);
    const bJobs = await prisma.verificationJob.findMany({ where: { batchId: batchB } });
    expect(bJobs.every((j) => j.status === "queued" && j.attempts === 0)).toBe(true);

    // The global tick then serves legacy — and still ignores pending batch B.
    const globalProcessed = await processDueVerificationJobs();
    expect(globalProcessed).toBe(1);
    expect(verifyAndNormalize.mock.calls[2][0]).toBe("legacy@old.com");
    const bAfter = await prisma.verificationJob.findMany({ where: { batchId: batchB } });
    expect(bAfter.every((j) => j.status === "queued" && j.attempts === 0)).toBe(true);
  });

  it("runBatchWorker drives a running batch to completed with live counters", async () => {
    authed(ownerId);
    const batchId = await createBatch(["one@x.com", "two@x.com", "three@x.com"]);
    expect((await json(await startBatch(batchId))).batch.status).toBe("running");
    verifyAndNormalize.mockImplementation(async (email) => ({ ok: true, result: validResult(email) }));

    const { runBatchWorker } = await import("@/lib/verification/worker");
    const outcome = await runBatchWorker(batchId);
    expect(outcome).toBe("completed");

    const row = await prisma.verificationBatch.findUnique({ where: { id: batchId } });
    expect(row?.status).toBe("completed");
    expect(row?.completedAt).not.toBeNull();
    expect(row?.startedAt).not.toBeNull();
    // Counters are a faithful view of the jobs/results below.
    expect(row?.total).toBe(3);
    expect(row?.queued).toBe(0);
    expect(row?.running).toBe(0);
    expect(row?.completed).toBe(3);
    expect(row?.failed).toBe(0);
    expect(row?.valid).toBe(3);
    expect(row?.invalid).toBe(0);
  }, 60_000);

  it("refreshBatch self-heals corrupted counters instead of accumulating them", async () => {
    authed(ownerId);
    const batchId = await createBatch(["a@x.com", "b@y.com"]);
    await prisma.verificationBatch.update({
      where: { id: batchId },
      data: { valid: 99, queued: 7, total: -5 },
    });

    const { refreshBatch } = await import("@/lib/verification/batch");
    const fresh = await refreshBatch(batchId);
    expect(fresh?.total).toBe(2);
    expect(fresh?.queued).toBe(2);
    expect(fresh?.valid).toBe(0);
    expect(fresh?.completed).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("state machine", () => {
  it("allows exactly the documented transitions", async () => {
    const { canTransition } = await import("@/lib/verification/batch");
    expect(canTransition("pending", "running")).toBe(true);
    expect(canTransition("pending", "cancelled")).toBe(true);
    expect(canTransition("pending", "failed")).toBe(true);
    expect(canTransition("pending", "completed")).toBe(false);

    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("running", "cancelled")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("running", "pending")).toBe(false);

    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("completed", "cancelled")).toBe(false);
    expect(canTransition("cancelled", "running")).toBe(false);
    expect(canTransition("cancelled", "pending")).toBe(false);
    expect(canTransition("failed", "cancelled")).toBe(false);
    expect(canTransition("bogus", "running")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("batch export", () => {
  it("exports only the owned batch's verified addresses", async () => {
    const legacy = await seedLegacyJob("legacy@old.com");
    verifyAndNormalize.mockImplementation(async (email) => ({ ok: true, result: validResult(email) }));
    const { processDueVerificationJobs } = await import("@/lib/verification/worker");

    // Give the legacy job a real stored result — so a missing batch filter
    // would visibly leak it into the CSV below.
    await processDueVerificationJobs();
    expect(legacy.batchId).toBeNull();

    authed(ownerId);
    const batchId = await createBatch(["a@x.com", "b@y.com"]);
    await startBatch(batchId);
    await processDueVerificationJobs({ batchId });

    const { GET: exportGet } = await import("@/app/api/email-verification/export/route");
    const res = await exportGet(
      new Request(`${ORIGIN}/api/email-verification/export?batchId=${batchId}`),
    );
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain("a@x.com");
    expect(csv).toContain("b@y.com");
    expect(csv).not.toContain("legacy@old.com");
  });

  it("lists a batch's jobs for its owner only", async () => {
    authed(ownerId);
    const batchId = await createBatch(["a@x.com", "b@y.com"]);

    const mine = await json(await batchJobs(batchId));
    expect(mine.total).toBe(2);
    expect(new Set(mine.jobs.map((j: any) => j.email))).toEqual(
      new Set(["a@x.com", "b@y.com"]),
    );
    expect(mine.jobs.every((j: any) => j.status === "queued")).toBe(true);

    authed(strangerId);
    expect((await batchJobs(batchId)).status).toBe(404);
  });
});
