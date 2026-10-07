/**
 * Campaign lead import acceptance tests — the real save/preview flow against a
 * throwaway Postgres instance.
 *
 * Business rule under test: EMAIL IS THE ONLY REQUIRED FIELD for a campaign
 * lead. A row is imported when its email is present, syntactically valid and
 * not a duplicate — even when every other cell (first/last name, company,
 * phone, custom fields) is empty. Missing optional fields are persisted as
 * empty/null, never as invented placeholders, and duplicate protection is
 * unchanged.
 *
 * The route handlers are imported directly with `getSession` mocked, exactly
 * like the warmup and verification API suites.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestDatabase, stopTestDatabase } from "./helpers/test-db";

const getSession = vi.fn<() => Promise<{ sub: string } | null>>();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession };
});

import { createUser } from "./helpers/fixtures";
import type { PrismaClient } from "@prisma/client";

let prisma: PrismaClient;
let ownerId: string;
let strangerId: string;

const ORIGIN = "http://localhost:3000";

beforeAll(async () => {
  await startTestDatabase();
  prisma = (await import("@/lib/prisma")).prisma;
  ownerId = (await createUser(prisma, "lead-owner@test.example")).id;
  strangerId = (await createUser(prisma, "lead-stranger@test.example")).id;
}, 300_000);

afterAll(async () => {
  await stopTestDatabase();
}, 120_000);

beforeEach(async () => {
  getSession.mockReset();
  await prisma.leadGroup.deleteMany({});
  await prisma.group.deleteMany({});
  await prisma.lead.deleteMany({});
});

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function saveCsv(csv: string) {
  const { POST } = await import("@/app/api/leads/import/save/route");
  getSession.mockResolvedValue({ sub: ownerId });
  const res = await POST(post(ORIGIN, { csv }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function previewCsv(csv: string) {
  const { POST } = await import("@/app/api/leads/import/preview/route");
  getSession.mockResolvedValue({ sub: ownerId });
  const res = await POST(post(ORIGIN, { csv }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const byEmail = async (email: string) =>
  prisma.lead.findUnique({ where: { userId_email: { userId: ownerId, email } } });

describe("POST /api/leads/import/save — email-only campaign leads", () => {
  it("imports all five rows of the acceptance CSV (valid unique emails)", async () => {
    const csv = [
      "email,firstName,lastName,company,phone",
      "john@example.com,,,,",
      "jane@example.com,Jane,,,",
      "bob@example.com,,Smith,,",
      "alice@example.com,,,ABC Medical,",
      "tom@example.com,Tom,Jones,ABC Medical,",
    ].join("\n");

    const { status, body } = await saveCsv(csv);

    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 5, imported: 5, duplicates: 0, invalid: 0 });

    const rows = await prisma.lead.findMany({ where: { userId: ownerId } });
    expect(rows).toHaveLength(5);
    const emails = rows.map((l) => l.email).sort();
    expect(emails).toEqual([
      "alice@example.com",
      "bob@example.com",
      "jane@example.com",
      "john@example.com",
      "tom@example.com",
    ]);
  });

  it("stores an email-only lead with empty optional fields — no invented placeholders", async () => {
    const { status } = await saveCsv("email\njohn@example.com\n");
    expect(status).toBe(200);

    const lead = await byEmail("john@example.com");
    expect(lead).not.toBeNull();
    expect(lead!.firstName).toBe(""); // empty, NOT "Unknown"/"N/A"/etc.
    expect(lead!.lastName).toBeNull();
    expect(lead!.practiceName).toBeNull();
    expect(lead!.phone).toBeNull();
    expect(lead!.customField1).toBeNull();
    expect(lead!.customField2).toBeNull();
  });

  it("keeps the fields that ARE provided on partially-empty rows", async () => {
    await saveCsv("email,firstName,lastName,company,phone\njane@example.com,Jane,,ABC Medical,\n");

    const jane = await byEmail("jane@example.com");
    expect(jane!.firstName).toBe("Jane");
    expect(jane!.lastName).toBeNull();
    expect(jane!.practiceName).toBe("ABC Medical");
    expect(jane!.phone).toBeNull();
  });

  it("skips only the row with a missing email and imports the rest", async () => {
    const csv = "email,firstName,lastName\n,John,Smith\njane@example.com,Jane,Smith\n";
    const { status, body } = await saveCsv(csv);

    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 2, imported: 1, invalid: 1 });

    const leads = await prisma.lead.findMany({ where: { userId: ownerId } });
    expect(leads).toHaveLength(1);
    expect(leads[0].email).toBe("jane@example.com");
  });

  it("rejects a file whose only row has an invalid email", async () => {
    const { status, body } = await saveCsv("email,firstName\nnot-a-real-email,John\n");
    expect(status).toBe(400);
    expect(String((body as { error?: string }).error)).toContain("No importable contacts found");
    expect(await prisma.lead.count({ where: { userId: ownerId } })).toBe(0);
  });

  it("collapses within-file duplicates to one lead (duplicate rules unchanged)", async () => {
    const csv = "email,firstName\ndup@example.com,A\ndup@example.com,B\n";
    const { status, body } = await saveCsv(csv);

    expect(status).toBe(200);
    // Existing save semantics: the repeated address collapses into a single
    // imported lead; the `duplicates` counter reflects addresses that already
    // existed in the DB (here: none), not repeats inside the file.
    expect(body).toMatchObject({ imported: 1, duplicates: 0 });
    expect(await prisma.lead.count({ where: { userId: ownerId } })).toBe(1);
  });

  it("never recreates an address that already exists", async () => {
    await saveCsv("email\njohn@example.com\n");
    const { body } = await saveCsv("email,firstName\njohn@example.com,John\n");

    expect(body).toMatchObject({ imported: 0, duplicates: 1, invalid: 0 });
    expect(await prisma.lead.count({ where: { userId: ownerId } })).toBe(1);
    // Existing lead is not augmented.
    const lead = await byEmail("john@example.com");
    expect(lead!.firstName).toBe("");
  });

  it("isolates users: another user's leads never block this user's import", async () => {
    getSession.mockResolvedValue({ sub: strangerId });
    const { POST } = await import("@/app/api/leads/import/save/route");
    await POST(post(ORIGIN, { csv: "email\nshared@example.com\n" }));

    const { body } = await saveCsv("email\nshared@example.com\n");
    expect(body).toMatchObject({ imported: 1, duplicates: 0 });
    expect(await byEmail("shared@example.com")).not.toBeNull();
  });

  it("refuses an unauthenticated save", async () => {
    getSession.mockResolvedValue(null);
    const { POST } = await import("@/app/api/leads/import/save/route");
    const res = await POST(post(ORIGIN, { csv: "email\njohn@example.com\n" }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/leads/import/preview — email-only rows show as VALID", () => {
  it("renders an email-only row as usable with zero errors", async () => {
    const { status, body } = await previewCsv("email,firstName,lastName,company\njohn@example.com,,,,\n");

    expect(status).toBe(200);
    const rows = body.rows as Array<{
      firstName: string;
      usable: boolean;
      errors: unknown[];
      duplicate: boolean;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].firstName).toBe("");
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].duplicate).toBe(false);
    expect(rows[0].usable).toBe(true);
    expect(body.counts).toMatchObject({ total: 1, valid: 1, errors: 0, duplicates: 0 });
  });

  it("marks only the bad rows invalid in a mixed file", async () => {
    const { body } = await previewCsv(
      "email,firstName\njohn@example.com,John\n,NoEmail\n",
    );
    const rows = body.rows as Array<{ email: string; usable: boolean; errors: { message: string }[] }>;
    expect(rows[0].usable).toBe(true);
    expect(rows[0].errors).toEqual([]);
    expect(rows[1].usable).toBe(false);
    expect(rows[1].errors.map((e) => e.message)).toContain("Missing email");
    expect(body.counts).toMatchObject({ total: 2, valid: 1, errors: 1 });
  });
});