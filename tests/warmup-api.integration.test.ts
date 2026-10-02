/**
 * Warm-up API route security tests.
 *
 * These import each route handler and call it directly, with `getSession`
 * mocked. That exercises the handler's OWN authorisation logic -- the part that
 * could be wrong -- without needing a running Next server.
 *
 * The rules under test, for every route:
 *   1. an unauthenticated caller is refused,
 *   2. every read and write is scoped to the session's own user,
 *   3. no SMTP or IMAP secret is ever returned, in any form,
 *   4. no caller-supplied recipient or volume can slip past validation.
 *
 * The DB-backed service layer behind these routes is covered by
 * warmup-worker.integration.test.ts; the only mock here is the session.
 *
 * NOTE on status codes: the house helper for a missing session is `forbidden()`
 * (403), not `unauthorized()` (401). These tests assert the code the codebase
 * actually returns rather than the one that sounds more correct.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestDatabase, stopTestDatabase } from "./helpers/test-db";

const getSession = vi.fn<() => Promise<{ sub: string } | null>>();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession };
});

import { createUser, createSmtpAccount, enrollMailbox, setDailyLimit } from "./helpers/fixtures";
import type { PrismaClient } from "@prisma/client";

let prisma: PrismaClient;
let ownerId: string;
let strangerId: string;
let ownerAccountId: string;

const ORIGIN = "http://localhost:3000";
const GOOD = { origin: ORIGIN };

beforeAll(async () => {
  await startTestDatabase();
  prisma = (await import("@/lib/prisma")).prisma;
  ownerId = (await createUser(prisma, "api-owner@test.example")).id;
  strangerId = (await createUser(prisma, "api-stranger@test.example")).id;
  await setDailyLimit(prisma, ownerId, 50);
  await setDailyLimit(prisma, strangerId, 50);

  const a = await createSmtpAccount(prisma, ownerId, { email: "owner-mailbox@test.example" });
  ownerAccountId = a.id;
  await enrollMailbox(prisma, ownerId, a.id, { enabled: true, status: "running" });

  const b = await createSmtpAccount(prisma, strangerId, { email: "stranger-mailbox@test.example" });
  await enrollMailbox(prisma, strangerId, b.id, { enabled: true, status: "running" });
}, 300_000);

afterAll(async () => {
  await stopTestDatabase();
}, 120_000);

beforeEach(() => {
  getSession.mockReset();
});

/** Next.js dynamic-segment route context. */
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const post = (origin: string) => new Request(origin, { method: "POST", headers: { origin } });
const patch = (origin: string, body: unknown) =>
  new Request(origin, { method: "PATCH", headers: { origin }, body: JSON.stringify(body) });

/**
 * Walk a response body looking for anything credential-shaped.
 *
 * A blunt substring search for "password" is useless here: legitimately useful
 * flags like `hasSeparatePassword: false` are exactly what an operator should
 * see. What must never appear is (a) a key that IS a credential, (b) a key
 * holding an encrypted blob, or (c) a secret's actual plaintext value.
 */
function assertNoCredentials(payload: unknown, secretValues: string[] = ["super-secret-password"]): void {
  const credentialKey = /^(password|username|secret|token|passphrase|smtpPassword|imapPassword)$/i;
  const blobKey = /encrypted$|ciphertext|blob$/i;

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        // A boolean "do we have one of these?" flag is fine; the secret is not.
        if ((credentialKey.test(key) || blobKey.test(key)) && typeof value !== "boolean") {
          throw new Error(`response exposed credential field ${path}.${key} (${typeof value})`);
        }
        walk(value, `${path}.${key}`);
      }
      return;
    }
    if (typeof node === "string") {
      for (const secret of secretValues) {
        if (secret.length > 3 && node.toLowerCase().includes(secret.toLowerCase())) {
          throw new Error(`response leaked the plaintext of ${path}`);
        }
      }
      // Ciphertext is base64-ish; encrypted blobs are the giveaway.
      if (blobKey.test(path) && node.length > 16) {
        throw new Error(`response leaked an encrypted blob at ${path}`);
      }
    }
  };

  try {
    walk(payload, "body");
  } catch (err) {
    expect.fail(String(err instanceof Error ? err.message : err));
  }
}

// ===========================================================================
// 1. Authentication
// ===========================================================================

describe("authentication is required on every warm-up route", () => {
  it("GET /api/warmup/mailboxes", async () => {
    getSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/warmup/mailboxes/route");
    expect(((await GET()) as Response).status).toBe(403);
  });

  it("GET /api/warmup/stats", async () => {
    getSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/warmup/stats/route");
    expect(((await GET(new Request(`${ORIGIN}/api/warmup/stats`))) as Response).status).toBe(403);
  });

  it("GET /api/warmup/events", async () => {
    getSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/warmup/events/route");
    expect(((await GET(new Request(`${ORIGIN}/api/warmup/events`))) as Response).status).toBe(403);
  });

  it("GET /api/warmup/settings", async () => {
    getSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/warmup/settings/route");
    expect(((await GET()) as Response).status).toBe(403);
  });

  it("GET /api/warmup/mailboxes/:id/imap", async () => {
    getSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/warmup/mailboxes/[id]/imap/route");
    expect(((await GET(new Request(`${ORIGIN}/api/warmup/mailboxes/1/imap`), ctx(ownerAccountId) as never)) as Response).status).toBe(403);
  });

  it("POST /api/warmup/mailboxes/:id/start", async () => {
    getSession.mockResolvedValue(null);
    const { POST } = await import("@/app/api/warmup/mailboxes/[id]/start/route");
    expect(((await POST(post(ORIGIN), ctx(ownerAccountId) as never)) as Response).status).toBe(403);
  });

  it("POST /api/warmup/mailboxes/:id/pause", async () => {
    getSession.mockResolvedValue(null);
    const { POST } = await import("@/app/api/warmup/mailboxes/[id]/pause/route");
    expect(((await POST(post(ORIGIN), ctx(ownerAccountId) as never)) as Response).status).toBe(403);
  });

  it("POST /api/warmup/mailboxes/:id/reset", async () => {
    getSession.mockResolvedValue(null);
    const { POST } = await import("@/app/api/warmup/mailboxes/[id]/reset/route");
    expect(((await POST(post(ORIGIN), ctx(ownerAccountId) as never)) as Response).status).toBe(403);
  });

  it("POST /api/warmup/mailboxes/:id/imap/test", async () => {
    getSession.mockResolvedValue(null);
    const { POST } = await import("@/app/api/warmup/mailboxes/[id]/imap/test/route");
    expect(((await POST(post(ORIGIN), ctx(ownerAccountId) as never)) as Response).status).toBe(403);
  });

  it("PATCH /api/warmup/settings", async () => {
    getSession.mockResolvedValue(null);
    const { PATCH } = await import("@/app/api/warmup/settings/route");
    expect(((await PATCH(patch(ORIGIN, { warmupStartingDailyVolume: 9 }))) as Response).status).toBe(403);
  });

  it("PATCH /api/warmup/mailboxes/:id", async () => {
    getSession.mockResolvedValue(null);
    const { PATCH } = await import("@/app/api/warmup/mailboxes/[id]/route");
    expect(((await PATCH(patch(ORIGIN, { enabled: true }), ctx(ownerAccountId) as never)) as Response).status).toBe(403);
  });
});

// ===========================================================================
// 2. Ownership
// ===========================================================================

describe("ownership is enforced", () => {
  it("cannot start warm-up for another user's mailbox", async () => {
    getSession.mockResolvedValue({ sub: strangerId });
    const { POST } = await import("@/app/api/warmup/mailboxes/[id]/start/route");
    const res = (await POST(post(ORIGIN), ctx(ownerAccountId) as never)) as Response;
    // notFound, by design: do not confirm the id exists for a non-owner.
    expect(res.status).toBe(404);
  });

  it("cannot pause another user's mailbox, and their state is untouched", async () => {
    getSession.mockResolvedValue({ sub: strangerId });
    const before = await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { smtpAccountId: ownerAccountId } });
    const { POST } = await import("@/app/api/warmup/mailboxes/[id]/pause/route");
    const res = (await POST(post(ORIGIN), ctx(ownerAccountId) as never)) as Response;
    expect(res.status).toBe(404);

    const after = await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { smtpAccountId: ownerAccountId } });
    expect(after.status).toBe(before.status);
    expect(after.enabled).toBe(before.enabled);
  });

  it("cannot reset another user's mailbox", async () => {
    getSession.mockResolvedValue({ sub: strangerId });
    const { POST } = await import("@/app/api/warmup/mailboxes/[id]/reset/route");
    expect(((await POST(post(ORIGIN), ctx(ownerAccountId) as never)) as Response).status).toBe(404);
  });

  it("cannot read another user's IMAP configuration", async () => {
    getSession.mockResolvedValue({ sub: strangerId });
    const { GET } = await import("@/app/api/warmup/mailboxes/[id]/imap/route");
    const res = (await GET(new Request(`${ORIGIN}/api/warmup/mailboxes/1/imap`), ctx(ownerAccountId) as never)) as Response;
    expect(res.status).toBe(404);
    assertNoCredentials(await res.json().catch(() => ({})));
  });

  it("cannot write another user's IMAP configuration", async () => {
    getSession.mockResolvedValue({ sub: strangerId });
    const before = await prisma.smtpAccount.findUniqueOrThrow({ where: { id: ownerAccountId } });
    const { PATCH } = await import("@/app/api/warmup/mailboxes/[id]/imap/route");
    const res = (await PATCH(patch(ORIGIN, { imapHost: "attacker.example" }), ctx(ownerAccountId) as never)) as Response;
    expect(res.status).toBe(404);
    const after = await prisma.smtpAccount.findUniqueOrThrow({ where: { id: ownerAccountId } });
    expect(after.imapHost).toBe(before.imapHost);
  });

  it("cannot patch another user's warm-up settings", async () => {
    getSession.mockResolvedValue({ sub: strangerId });
    const before = await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { smtpAccountId: ownerAccountId } });
    const { PATCH } = await import("@/app/api/warmup/mailboxes/[id]/route");
    const res = (await PATCH(patch(ORIGIN, { enabled: false }), ctx(ownerAccountId) as never)) as Response;
    expect(res.status).toBe(404);
    const after = await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { smtpAccountId: ownerAccountId } });
    expect(after.enabled).toBe(before.enabled);
  });

  it("the mailbox list contains only the caller's own mailboxes", async () => {
    getSession.mockResolvedValue({ sub: strangerId });
    const { GET } = await import("@/app/api/warmup/mailboxes/route");
    const res = (await GET()) as Response;
    expect(res.status).toBe(200);
    const blob = JSON.stringify(await res.json());
    expect(blob).not.toContain("owner-mailbox@test.example");
    expect(blob).toContain("stranger-mailbox@test.example");
  });

  it("stats for a mailbox the caller does not own are refused", async () => {
    getSession.mockResolvedValue({ sub: strangerId });
    const { GET } = await import("@/app/api/warmup/stats/route");
    const res = (await GET(new Request(`${ORIGIN}/api/warmup/stats?smtpAccountId=${ownerAccountId}`))) as Response;
    const blob = JSON.stringify(await res.json().catch(() => ({})));
    // Either refused outright, or answered without the other user's data.
    expect(res.status === 404 || !blob.includes(ownerAccountId)).toBe(true);
  });
});

// ===========================================================================
// 3. No credential ever leaves the server
// ===========================================================================

describe("no route returns credentials", () => {
  it("GET /api/warmup/mailboxes", async () => {
    getSession.mockResolvedValue({ sub: ownerId });
    const { GET } = await import("@/app/api/warmup/mailboxes/route");
    const res = (await GET()) as Response;
    expect(res.status).toBe(200);
    assertNoCredentials(await res.json());
  });

  it("GET /api/warmup/mailboxes/:id/imap -- even to the owner", async () => {
    getSession.mockResolvedValue({ sub: ownerId });
    const { GET } = await import("@/app/api/warmup/mailboxes/[id]/imap/route");
    const res = (await GET(new Request(`${ORIGIN}/api/warmup/mailboxes/1/imap`), ctx(ownerAccountId) as never)) as Response;
    expect(res.status).toBe(200);
    assertNoCredentials(await res.json());
  });

  it("GET /api/warmup/stats", async () => {
    getSession.mockResolvedValue({ sub: ownerId });
    const { GET } = await import("@/app/api/warmup/stats/route");
    const res = (await GET(new Request(`${ORIGIN}/api/warmup/stats`))) as Response;
    expect(res.status).toBe(200);
    assertNoCredentials(await res.json());
  });

  it("GET /api/warmup/events", async () => {
    getSession.mockResolvedValue({ sub: ownerId });
    const { GET } = await import("@/app/api/warmup/events/route");
    const res = (await GET(new Request(`${ORIGIN}/api/warmup/events`))) as Response;
    expect(res.status).toBe(200);
    assertNoCredentials(await res.json());
  });

  it("GET /api/warmup/settings", async () => {
    getSession.mockResolvedValue({ sub: ownerId });
    const { GET } = await import("@/app/api/warmup/settings/route");
    const res = (await GET()) as Response;
    expect(res.status).toBe(200);
    assertNoCredentials(await res.json());
  });

  it("PATCH /api/warmup/mailboxes/:id/imap does not echo the password it stored", async () => {
    getSession.mockResolvedValue({ sub: ownerId });
    const { PATCH } = await import("@/app/api/warmup/mailboxes/[id]/imap/route");
    const res = (await PATCH(
      patch(ORIGIN, { imapHost: "imap.test.example", imapPassword: "a-brand-new-secret" }),
      ctx(ownerAccountId) as never,
    )) as Response;
    assertNoCredentials(await res.json().catch(() => ({})), ["a-brand-new-secret", "super-secret-password"]);
    // And the stored value really was encrypted, not saved in the clear.
    const row = await prisma.smtpAccount.findUniqueOrThrow({ where: { id: ownerAccountId } });
    expect(row.imapPasswordEncrypted).not.toContain("a-brand-new-secret");
  });
});

// ===========================================================================
// 4. CSRF / origin
// ===========================================================================

describe("state-changing routes require a same-origin request", () => {
  it("rejects a cross-origin start", async () => {
    getSession.mockResolvedValue({ sub: ownerId });
    const { POST } = await import("@/app/api/warmup/mailboxes/[id]/start/route");
    const res = (await POST(post("http://evil.example"), ctx(ownerAccountId) as never)) as Response;
    expect(res.status).toBe(403);
  });

  it("rejects a cross-origin settings patch and leaves the value unchanged", async () => {
    getSession.mockResolvedValue({ sub: ownerId });
    const { getSendSettings } = await import("@/lib/settings");
    const before = (await getSendSettings(ownerId)).warmupMaximumDailyVolume;
    const { PATCH } = await import("@/app/api/warmup/settings/route");
    const res = (await PATCH(patch("http://evil.example", { warmupMaximumDailyVolume: 999 }))) as Response;
    expect(res.status).toBe(403);
    expect((await getSendSettings(ownerId)).warmupMaximumDailyVolume).toBe(before);
  });

  it("rejects a cross-origin mailbox patch", async () => {
    getSession.mockResolvedValue({ sub: ownerId });
    const { PATCH } = await import("@/app/api/warmup/mailboxes/[id]/route");
    const res = (await PATCH(patch("http://evil.example", { enabled: false }), ctx(ownerAccountId) as never)) as Response;
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// 5. Validation: no quota bypass, no pool bypass
// ===========================================================================

describe("validation prevents quota and pool bypass", () => {
  it("rejects an absurd maximum volume", async () => {
    getSession.mockResolvedValue({ sub: ownerId });
    const { PATCH } = await import("@/app/api/warmup/mailboxes/[id]/route");
    const res = (await PATCH(
      patch(ORIGIN, { maximumDailyVolume: 100000, startingDailyVolume: 90000 }),
      ctx(ownerAccountId) as never,
    )) as Response;
    expect(res.status).toBeGreaterThanOrEqual(400);

    const s = await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { smtpAccountId: ownerAccountId } });
    expect(s.maximumDailyVolume).toBeLessThanOrEqual(1000);
    expect(s.startingDailyVolume).toBeLessThanOrEqual(1000);
  });

  it("rejects an inverted warm-up window", async () => {
    getSession.mockResolvedValue({ sub: ownerId });
    const { PATCH } = await import("@/app/api/warmup/mailboxes/[id]/route");
    const res = (await PATCH(
      patch(ORIGIN, { warmupWindowStart: "18:00", warmupWindowEnd: "09:00" }),
      ctx(ownerAccountId) as never,
    )) as Response;
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects starting above the maximum", async () => {
    getSession.mockResolvedValue({ sub: ownerId });
    const { PATCH } = await import("@/app/api/warmup/mailboxes/[id]/route");
    const res = (await PATCH(
      patch(ORIGIN, { startingDailyVolume: 20, maximumDailyVolume: 10 }),
      ctx(ownerAccountId) as never,
    )) as Response;
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects a non-numeric or negative volume", async () => {
    getSession.mockResolvedValue({ sub: ownerId });
    const { PATCH } = await import("@/app/api/warmup/mailboxes/[id]/route");
    for (const bad of [{ startingDailyVolume: -5 }, { startingDailyVolume: "lots" }]) {
      const res = (await PATCH(patch(ORIGIN, bad), ctx(ownerAccountId) as never)) as Response;
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("no route accepts a recipient address: the pool is the only source", async () => {
    // Deliberately smuggles a destination into a patch body. Even if the body
    // is accepted, nothing may end up routing mail to that address.
    getSession.mockResolvedValue({ sub: ownerId });
    const { PATCH } = await import("@/app/api/warmup/mailboxes/[id]/route");
    await PATCH(
      patch(ORIGIN, { enabled: true, receiverEmail: "attacker@evil.example", to: "attacker@evil.example" }),
      ctx(ownerAccountId) as never,
    );
    const settings = await prisma.warmupMailboxSettings.findUniqueOrThrow({ where: { smtpAccountId: ownerAccountId } });
    expect(JSON.stringify(settings).toLowerCase()).not.toContain("attacker@evil.example");
  });

  it("the IMAP password is write-only: omitting it preserves the stored value", async () => {
    getSession.mockResolvedValue({ sub: ownerId });
    const before = await prisma.smtpAccount.findUniqueOrThrow({ where: { id: ownerAccountId } });
    const originalPassword = before.imapPasswordEncrypted;
    const originalUsername = before.imapUsernameEncrypted;

    const { PATCH } = await import("@/app/api/warmup/mailboxes/[id]/imap/route");
    const res = (await PATCH(
      patch(ORIGIN, { imapHost: "imap.updated.example", imapPort: 993 }),
      ctx(ownerAccountId) as never,
    )) as Response;
    expect(res.status).toBe(200);

    const after = await prisma.smtpAccount.findUniqueOrThrow({ where: { id: ownerAccountId } });
    expect(after.imapHost).toBe("imap.updated.example");
    // Blank means "leave it alone", not "erase it".
    expect(after.imapPasswordEncrypted).toBe(originalPassword);
    expect(after.imapUsernameEncrypted).toBe(originalUsername);
  });
});