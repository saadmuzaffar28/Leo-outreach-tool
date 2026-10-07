/**
 * Verification service integration tests — real Postgres, engine faked.
 *
 * The DB layer (cache, persistence, queueing, cross-user isolation, stats,
 * listing) is the code under test, so it runs against the throwaway embedded
 * Postgres like the other integration suites. Only the engine is mocked: the
 * worker tests own the engine-calling path.
 *
 * Rules these tests pin:
 *   - a fresh stored row is reused (cache) unless `force` is set;
 *   - transient engine failures are NOT persisted (an outage cannot poison
 *     the cache); non-transient failures are stored as UNKNOWN;
 *   - every row is scoped to its user.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestDatabase, stopTestDatabase } from "./helpers/test-db";
import { createUser } from "./helpers/fixtures";
import { normalizeAfterShipResult } from "@/lib/verification/aftership-adapter";
import type { VerificationResult } from "@/lib/verification/types";
import { env } from "@/lib/env";
import type { PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// Fake the engine; everything else is real.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

let prisma: PrismaClient;
let service: typeof import("@/lib/verification/service");
let ownerId: string;
let strangerId: string;

/** Build a "clean VALID" engine result for an address. */
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
  service = await import("@/lib/verification/service");
  ownerId = (await createUser(prisma, "verif-owner@test.example")).id;
  strangerId = (await createUser(prisma, "verif-stranger@test.example")).id;
}, 300_000);

afterAll(async () => {
  await stopTestDatabase();
}, 120_000);

beforeEach(async () => {
  verifyAndNormalize.mockReset();
  await prisma.emailVerification.deleteMany({});
  await prisma.verificationJob.deleteMany({});
});

describe("verifySingle — engine path", () => {
  it("stores a normalized result and reports it as uncached", async () => {
    verifyAndNormalize.mockResolvedValue({ ok: true, result: validResult("DrUser@Example.COM") });

    const outcome = await service.verifySingle(ownerId, "DrUser@Example.COM");

    expect(outcome.cached).toBe(false);
    expect(outcome.row).not.toBeNull();
    expect(outcome.result.status).toBe("VALID");
    expect(outcome.result.normalizedEmail).toBe("druser@example.com");

    const stored = await prisma.emailVerification.findUnique({
      where: { userId_normalizedEmail: { userId: ownerId, normalizedEmail: "druser@example.com" } },
    });
    expect(stored?.status).toBe("VALID");
    expect(stored?.confidence).toBe(100);
    const ttlMs = env.EMAIL_VERIFICATION_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
    const deltaMs = stored!.expiresAt.getTime() - stored!.checkedAt.getTime();
    expect(deltaMs).toBeGreaterThanOrEqual(ttlMs - 5_000);
    expect(deltaMs).toBeLessThanOrEqual(ttlMs + 5_000);
  });

  it("reuses a fresh stored row without calling the engine", async () => {
    verifyAndNormalize.mockResolvedValue({ ok: true, result: validResult("a@x.com") });
    await service.verifySingle(ownerId, "a@x.com");
    expect(verifyAndNormalize).toHaveBeenCalledTimes(1);

    const again = await service.verifySingle(ownerId, "A@x.com");
    expect(again.cached).toBe(true);
    expect(verifyAndNormalize).toHaveBeenCalledTimes(1); // no second engine call
    expect(again.result.status).toBe("VALID");
  });

  it("force bypasses the cache and re-runs the engine", async () => {
    verifyAndNormalize.mockResolvedValue({ ok: true, result: validResult("b@x.com") });
    await service.verifySingle(ownerId, "b@x.com");
    const forced = await service.verifySingle(ownerId, "b@x.com", { force: true });
    expect(forced.cached).toBe(false);
    expect(verifyAndNormalize).toHaveBeenCalledTimes(2);
  });

  it("persists an INVALID result for malformed addresses without the engine", async () => {
    const outcome = await service.verifySingle(ownerId, "definitely-not-an-email");
    expect(verifyAndNormalize).not.toHaveBeenCalled();
    expect(outcome.result.status).toBe("INVALID");
    expect(outcome.row?.status).toBe("INVALID");
  });
});

describe("verifySingle — engine failure policy", () => {
  it("does NOT persist a transient engine failure (cache cannot be poisoned)", async () => {
    verifyAndNormalize.mockResolvedValue({
      ok: false,
      errorCode: "service_unavailable",
      errorMessage: "engine down",
      retryable: true,
    });

    const outcome = await service.verifySingle(ownerId, "c@x.com");

    expect(outcome.row).toBeNull();
    expect(outcome.result.status).toBe("UNKNOWN");
    expect(outcome.result.errorCode).toBe("service_unavailable");

    const stored = await prisma.emailVerification.findUnique({
      where: { userId_normalizedEmail: { userId: ownerId, normalizedEmail: "c@x.com" } },
    });
    expect(stored).toBeNull();

    // And the next call really does retry the engine instead of reusing a cache.
    verifyAndNormalize.mockResolvedValue({ ok: true, result: validResult("c@x.com") });
    const again = await service.verifySingle(ownerId, "c@x.com");
    expect(again.cached).toBe(false);
    expect(again.result.status).toBe("VALID");
  });

  it("stores a non-transient engine failure as UNKNOWN", async () => {
    verifyAndNormalize.mockResolvedValue({
      ok: false,
      errorCode: "engine_http_400",
      errorMessage: "bad request",
      retryable: false,
    });

    const outcome = await service.verifySingle(ownerId, "d@x.com");
    expect(outcome.row?.status).toBe("UNKNOWN");
    expect(outcome.row?.errorCode).toBe("engine_http_400");
  });
});

describe("enqueueVerifications", () => {
  it("normalizes, dedupes and counts invalid entries", async () => {
    const outcome = await service.enqueueVerifications(ownerId, [
      "E@X.COM",
      "e@x.com",
      "not-an-email",
      "f@y.com",
    ]);
    expect(outcome.total).toBe(4);
    expect(outcome.invalidFormat).toBe(1);
    expect(outcome.duplicates).toBe(1);
    expect(outcome.accepted).toBe(2);
    expect(outcome.queued).toBe(2);
  });

  it("skips addresses already covered by a fresh stored result", async () => {
    await prisma.emailVerification.create({
      data: {
        userId: ownerId,
        email: "g@x.com",
        normalizedEmail: "g@x.com",
        status: "VALID",
        confidence: 100,
        syntaxValid: true,
        domainValid: true,
        mxValid: true,
        smtpReachable: true,
        provider: "aftership",
        verificationVersion: "1.0.0",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const outcome = await service.enqueueVerifications(ownerId, ["g@x.com"]);
    expect(outcome.alreadyVerified).toBe(1);
    expect(outcome.queued).toBe(0);
  });

  it("force re-enqueues even when a fresh result exists", async () => {
    await prisma.emailVerification.create({
      data: {
        userId: ownerId,
        email: "h@x.com",
        normalizedEmail: "h@x.com",
        status: "VALID",
        confidence: 100,
        syntaxValid: true,
        domainValid: true,
        mxValid: true,
        smtpReachable: true,
        provider: "aftership",
        verificationVersion: "1.0.0",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const outcome = await service.enqueueVerifications(ownerId, ["h@x.com"], { force: true });
    expect(outcome.queued).toBe(1);
  });

  it("skips addresses already queued (active jobs)", async () => {
    await prisma.verificationJob.create({
      data: { userId: ownerId, email: "i@x.com", normalizedEmail: "i@x.com", status: "queued" },
    });
    const outcome = await service.enqueueVerifications(ownerId, ["i@x.com"]);
    expect(outcome.alreadyQueued).toBe(1);
    expect(outcome.queued).toBe(0);
  });
});

describe("statusesFor — gate lookups", () => {
  it("returns only the caller's rows, keyed by normalized email", async () => {
    await prisma.emailVerification.create({
      data: {
        userId: ownerId,
        email: "j@x.com",
        normalizedEmail: "j@x.com",
        status: "INVALID",
        confidence: 15,
        syntaxValid: true,
        domainValid: true,
        mxValid: false,
        provider: "aftership",
        verificationVersion: "1.0.0",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.emailVerification.create({
      data: {
        userId: strangerId,
        email: "j@x.com",
        normalizedEmail: "j@x.com",
        status: "VALID",
        confidence: 100,
        syntaxValid: true,
        domainValid: true,
        mxValid: true,
        smtpReachable: true,
        provider: "aftership",
        verificationVersion: "1.0.0",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const map = await service.statusesFor(ownerId, [" J@x.com "]);
    expect(map.get("j@x.com")?.status).toBe("INVALID");
    expect(map.size).toBe(1); // stranger's row is invisible
  });
});

describe("stats and listing", () => {
  it("aggregates per-user stats including queue state", async () => {
    await prisma.emailVerification.createMany({
      data: [
        {
          userId: ownerId, email: "k@x.com", normalizedEmail: "k@x.com", status: "VALID",
          confidence: 100, syntaxValid: true, domainValid: true, mxValid: true, smtpReachable: true,
          provider: "aftership", verificationVersion: "1.0.0", expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          userId: ownerId, email: "l@x.com", normalizedEmail: "l@x.com", status: "INVALID",
          confidence: 15, syntaxValid: false, provider: "aftership",
          verificationVersion: "1.0.0", expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          userId: strangerId, email: "m@x.com", normalizedEmail: "m@x.com", status: "VALID",
          confidence: 100, syntaxValid: true, domainValid: true, mxValid: true, smtpReachable: true,
          provider: "aftership", verificationVersion: "1.0.0", expiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
    });
    await prisma.verificationJob.create({
      data: { userId: ownerId, email: "n@x.com", normalizedEmail: "n@x.com", status: "queued" },
    });

    const stats = await service.verificationStats(ownerId);
    expect(stats.total).toBe(2); // stranger's row excluded
    expect(stats.byStatus.VALID).toBe(1);
    expect(stats.byStatus.INVALID).toBe(1);
    expect(stats.queued).toBe(1);
    expect(stats.fresh).toBe(2);
  });

  it("lists with status/q filters and pagination, most recent first", async () => {
    await prisma.emailVerification.createMany({
      data: [
        {
          userId: ownerId, email: "first@x.com", normalizedEmail: "first@x.com", status: "VALID",
          confidence: 100, syntaxValid: true, domainValid: true, mxValid: true, smtpReachable: true,
          provider: "aftership", verificationVersion: "1.0.0",
          checkedAt: new Date("2026-01-01T00:00:00Z"), expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          userId: ownerId, email: "second@y.com", normalizedEmail: "second@y.com", status: "INVALID",
          confidence: 15, syntaxValid: false, provider: "aftership", verificationVersion: "1.0.0",
          checkedAt: new Date("2026-01-02T00:00:00Z"), expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          userId: ownerId, email: "third@y.com", normalizedEmail: "third@y.com", status: "RISKY",
          confidence: 55, syntaxValid: true, domainValid: true, mxValid: true, smtpReachable: true,
          roleAccount: true, provider: "aftership", verificationVersion: "1.0.0",
          checkedAt: new Date("2026-01-03T00:00:00Z"), expiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
    });

    const all = await service.listVerifications(ownerId, { limit: 50, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.rows[0].email).toBe("third@y.com"); // newest first

    const invalid = await service.listVerifications(ownerId, { limit: 50, offset: 0, status: "INVALID" });
    expect(invalid.total).toBe(1);
    expect(invalid.rows[0].email).toBe("second@y.com");

    const q = await service.listVerifications(ownerId, { limit: 50, offset: 0, q: "X.com" });
    expect(q.rows.map((r) => r.email)).toEqual(["first@x.com"]);

    const paged = await service.listVerifications(ownerId, { limit: 2, offset: 0 });
    expect(paged.rows).toHaveLength(2);
    expect(paged.total).toBe(3);
  });

  it("getVerificationById refuses another user's row", async () => {
    const row = await prisma.emailVerification.create({
      data: {
        userId: ownerId, email: "own@x.com", normalizedEmail: "own@x.com", status: "VALID",
        confidence: 100, syntaxValid: true, domainValid: true, mxValid: true, smtpReachable: true,
        provider: "aftership", verificationVersion: "1.0.0", expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    expect((await service.getVerificationById(ownerId, row.id))?.id).toBe(row.id);
    expect(await service.getVerificationById(strangerId, row.id)).toBeNull();
  });

  it("reverify enqueues a forced job", async () => {
    const row = await prisma.emailVerification.create({
      data: {
        userId: ownerId, email: "re@x.com", normalizedEmail: "re@x.com", status: "INVALID",
        confidence: 15, syntaxValid: false, provider: "aftership",
        verificationVersion: "1.0.0", expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await service.reverify(ownerId, row);
    const job = await prisma.verificationJob.findFirst({ where: { userId: ownerId, normalizedEmail: "re@x.com" } });
    expect(job?.force).toBe(true);
    expect(job?.status).toBe("queued");
  });
});