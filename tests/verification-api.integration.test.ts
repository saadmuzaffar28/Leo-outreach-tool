/**
 * Email verification API route tests — handlers called directly, real Postgres.
 *
 * Same pattern as warmup-api.integration.test.ts: the session is mocked, the
 * engine is mocked, everything else (validation, ORM, cross-user scoping) is
 * real. The auth rules under test mirror the house ones: unauth ⇒ 403, every
 * read/write scoped to the session's user, and foreign rows 404.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestDatabase, stopTestDatabase } from "./helpers/test-db";
import { createUser } from "./helpers/fixtures";
import { normalizeAfterShipResult } from "@/lib/verification/aftership-adapter";
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

beforeAll(async () => {
  await startTestDatabase();
  prisma = (await import("@/lib/prisma")).prisma;
  ownerId = (await createUser(prisma, "api-owner@test.example")).id;
  strangerId = (await createUser(prisma, "api-stranger@test.example")).id;
}, 300_000);

afterAll(async () => {
  await stopTestDatabase();
}, 120_000);

beforeEach(() => {
  getSession.mockReset();
  verifyAndNormalize.mockReset();
});

function authed(sub: string) {
  getSession.mockResolvedValue({ sub, email: "x@test.example" });
}

describe("POST /api/email-verification/verify", () => {
  it("refuses unauthenticated callers", async () => {
    getSession.mockResolvedValue(null);
    const { POST } = await import("@/app/api/email-verification/verify/route");
    const res = await POST(new Request(ORIGIN, { method: "POST", headers: { origin: ORIGIN }, body: "{}" }));
    expect(res.status).toBe(403);
  });

  it("reports a malformed address as INVALID rather than refusing it", async () => {
    authed(ownerId);
    const { POST } = await import("@/app/api/email-verification/verify/route");
    const res = await POST(
      new Request(ORIGIN, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "nope" }) }),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).verification?.status).toBe("INVALID");
    await prisma.emailVerification.deleteMany({});
  });

  it("verifies, then serves from cache on the second call", async () => {
    authed(ownerId);
    verifyAndNormalize.mockResolvedValue({ ok: true, result: validResult("lead@x.com") });
    const { POST } = await import("@/app/api/email-verification/verify/route");

    const first = await POST(
      new Request(ORIGIN, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "LEAD@x.com" }) }),
    );
    expect(first.status).toBe(200);
    const firstBody = await json(first);
    expect(firstBody.verification?.status).toBe("VALID");
    expect(firstBody.cached).toBe(false);
    expect(firstBody.id).toBeTypeOf("string");
    expect(firstBody.disclaimer).toContain("not a guarantee");
    expect(verifyAndNormalize).toHaveBeenCalledTimes(1);

    const second = await POST(
      new Request(ORIGIN, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "lead@x.com" }) }),
    );
    expect((await json(second)).cached).toBe(true);
    expect(verifyAndNormalize).toHaveBeenCalledTimes(1);

    await prisma.emailVerification.deleteMany({});
  });
});

describe("POST /api/email-verification/bulk", () => {
  it("refuses unauthenticated callers", async () => {
    getSession.mockResolvedValue(null);
    const { POST } = await import("@/app/api/email-verification/bulk/route");
    const res = await POST(new Request(ORIGIN, { method: "POST", headers: { origin: ORIGIN }, body: "{}" }));
    expect(res.status).toBe(403);
  });

  it("requires emails or csv", async () => {
    authed(ownerId);
    const { POST } = await import("@/app/api/email-verification/bulk/route");
    const res = await POST(new Request(ORIGIN, { method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify({}) }));
    expect(res.status).toBe(400);
  });

  it("queues jobs from a pasted CSV, counting invalid/duplicate rows", async () => {
    authed(ownerId);
    const { POST } = await import("@/app/api/email-verification/bulk/route");
    const csv = "email\na@x.com\nA@x.com\nnot-an-email\nb@y.com";
    const res = await POST(
      new Request(ORIGIN, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ csv }) }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.queued).toBe(2);
    expect(body.invalidFormat).toBe(1);
    expect(body.duplicates).toBe(1);

    const jobs = await prisma.verificationJob.findMany({ where: { userId: ownerId } });
    expect(jobs.map((j) => j.normalizedEmail).sort()).toEqual(["a@x.com", "b@y.com"]);
    await prisma.verificationJob.deleteMany({});
    await prisma.emailVerification.deleteMany({});
  });

  it("accepts an emails array too", async () => {
    authed(ownerId);
    const { POST } = await import("@/app/api/email-verification/bulk/route");
    const res = await POST(
      new Request(ORIGIN, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ emails: ["c@z.io"] }) }),
    );
    expect(res.status).toBe(201);
    expect((await json(res)).queued).toBe(1);
    await prisma.verificationJob.deleteMany({});
  });
});

describe("GET /api/email-verification/stats + list + export + [id]", () => {
  async function seedOwnerRows() {
    await prisma.emailVerification.createMany({
      data: [
        {
          userId: ownerId, email: "s1@x.com", normalizedEmail: "s1@x.com", status: "VALID",
          confidence: 100, syntaxValid: true, domainValid: true, mxValid: true, smtpReachable: true,
          provider: "aftership", verificationVersion: "1.0.0", expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          userId: ownerId, email: "s2@x.com", normalizedEmail: "s2@x.com", status: "INVALID",
          confidence: 15, syntaxValid: false, provider: "aftership",
          verificationVersion: "1.0.0", expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          userId: strangerId, email: "s3@x.com", normalizedEmail: "s3@x.com", status: "VALID",
          confidence: 100, syntaxValid: true, domainValid: true, mxValid: true, smtpReachable: true,
          provider: "aftership", verificationVersion: "1.0.0", expiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
    });
  }

  it("stats are scoped to the session user", async () => {
    authed(ownerId);
    await seedOwnerRows();
    const { GET } = await import("@/app/api/email-verification/stats/route");
    const body = await json(await GET());
    expect(body.stats?.total).toBe(2);
    expect(body.stats?.byStatus?.VALID).toBe(1);
    expect(body.stats?.byStatus?.INVALID).toBe(1);
    await prisma.emailVerification.deleteMany({});
  });

  it("list filters by status and search, and hides strangers' rows", async () => {
    authed(ownerId);
    await seedOwnerRows();
    const { GET } = await import("@/app/api/email-verification/list/route");
    const all = await json(await GET(new Request(`${ORIGIN}/api/email-verification/list`)));
    expect(all.total).toBe(2);
    expect((all.rows as { email: string }[]).map((r) => r.email).sort()).toEqual(["s1@x.com", "s2@x.com"]);

    const invalid = await json(await GET(new Request(`${ORIGIN}/api/email-verification/list?status=INVALID`)));
    expect(invalid.total).toBe(1);
    expect((invalid.rows as { email: string }[])[0].email).toBe("s2@x.com");

    await prisma.emailVerification.deleteMany({});
  });

  it("rejects a bad status filter", async () => {
    authed(ownerId);
    const { GET } = await import("@/app/api/email-verification/list/route");
    const res = await GET(new Request(`${ORIGIN}/api/email-verification/list?status=BOGUS`));
    expect(res.status).toBe(400);
  });

  it("GET /:id returns the owner's row and 404s for a stranger", async () => {
    const row = await prisma.emailVerification.create({
      data: {
        userId: ownerId, email: "id@x.com", normalizedEmail: "id@x.com", status: "VALID",
        confidence: 100, syntaxValid: true, domainValid: true, mxValid: true, smtpReachable: true,
        provider: "aftership", verificationVersion: "1.0.0", expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const { GET } = await import("@/app/api/email-verification/[id]/route");
    const ctx = (id: string) => ({ params: { id } });

    authed(ownerId);
    const mine = await json(await GET(new Request(ORIGIN), ctx(row.id)));
    expect(mine.verification?.id).toBe(row.id);

    authed(strangerId);
    expect((await GET(new Request(ORIGIN), ctx(row.id))).status).toBe(404);

    await prisma.emailVerification.deleteMany({});
  });

  it("POST /:id/reverify queues a forced job and refuses strangers", async () => {
    const row = await prisma.emailVerification.create({
      data: {
        userId: ownerId, email: "re@x.com", normalizedEmail: "re@x.com", status: "INVALID",
        confidence: 15, syntaxValid: false, provider: "aftership",
        verificationVersion: "1.0.0", expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const { POST } = await import("@/app/api/email-verification/[id]/reverify/route");
    const ctx = (id: string) => ({ params: { id } });

    authed(strangerId);
    expect((await POST(new Request(ORIGIN, { method: "POST", headers: { origin: ORIGIN } }), ctx(row.id))).status).toBe(404);

    authed(ownerId);
    const body = await json(await POST(new Request(ORIGIN, { method: "POST", headers: { origin: ORIGIN } }), ctx(row.id)));
    expect(body.queued).toBe(true);
    const job = await prisma.verificationJob.findFirst({ where: { userId: ownerId, normalizedEmail: "re@x.com" } });
    expect(job?.force).toBe(true);

    await prisma.verificationJob.deleteMany({});
    await prisma.emailVerification.deleteMany({});
  });

  it("export returns a CSV limited to the session user", async () => {
    authed(ownerId);
    await seedOwnerRows();
    const { GET } = await import("@/app/api/email-verification/export/route");
    const res = await GET(new Request(`${ORIGIN}/api/email-verification/export`));
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    const lines = text.trim().split("\r\n");
    expect(lines[0].startsWith("email,status,confidence")).toBe(true);
    expect(lines.length).toBe(3); // header + 2 owner rows (stranger excluded)
    expect(text).toContain("s1@x.com");
    expect(text).not.toContain("s3@x.com");
    await prisma.emailVerification.deleteMany({});
  });
});