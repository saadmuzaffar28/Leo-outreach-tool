/**
 * Campaign queue reliability — integration tests.
 *
 * Runs against a REAL throwaway Postgres (helpers/test-db.ts) because both
 * behaviours under test are about the database, not about JavaScript:
 *
 *   1. SELECTION ORDER. processDueRecipients takes the first 10 rows matching a
 *      predicate that is true for most of the queue. Whether a recipient is
 *      ever picked up therefore depends entirely on the ORDER BY, and an ORDER
 *      BY that is not a TOTAL order does not deterministically pick anyone. No
 *      mock can demonstrate this — it is a property of the rows and the planner.
 *
 *   2. RESTART SAFETY. Whether `start` erases send history is a question about
 *      what the DELETE actually matches against real rows carrying real
 *      `attempts` values.
 *
 * Only the network is faked: `sendSmtpMail` (and the session for the route
 * tests). Routing, claiming, leasing, backoff, quota, suppression, the delete/
 * re-seed transaction and the status machine are all the real code.
 *
 * NO TEST HERE SENDS REAL EMAIL. `sendSmtpMail` is mocked module-wide.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { startTestDatabase, stopTestDatabase } from "./helpers/test-db";

// ---------------------------------------------------------------------------
// Fake the network. Everything else is real.
// ---------------------------------------------------------------------------

const sendSmtpMail = vi.fn<(a: unknown, m: { to: string }) => Promise<unknown>>();

vi.mock("@/lib/smtp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/smtp")>();
  return { ...actual, sendSmtpMail };
});

const getSession = vi.fn<() => Promise<{ sub: string; email: string } | null>>();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession };
});

// ---------------------------------------------------------------------------

import {
  createUser,
  createSmtpAccount,
  createTemplate,
  createLead,
  createCampaign,
  createRecipients,
  setPermissiveSendSettings,
} from "./helpers/fixtures";
import type { PrismaClient } from "@prisma/client";

let prisma: PrismaClient;
let worker: typeof import("@/lib/worker");
let statusRoute: typeof import("@/app/api/campaigns/[id]/status/route");

let userId: string;

beforeAll(async () => {
  await startTestDatabase();
  prisma = (await import("@/lib/prisma")).prisma;
  worker = await import("@/lib/worker");
  statusRoute = await import("@/app/api/campaigns/[id]/status/route");
  userId = (await createUser(prisma, "campaign-owner@test.example")).id;
  await setPermissiveSendSettings(prisma, userId);
}, 300_000);

afterAll(async () => {
  await stopTestDatabase();
}, 120_000);

beforeEach(() => {
  sendSmtpMail.mockReset();
  sendSmtpMail.mockResolvedValue({
    messageId: "<test@mock>",
    accepted: ["x@example.com"],
    rejected: [],
    response: "250 2.0.0 Ok: queued as MOCK",
  });
  getSession.mockReset();
  getSession.mockResolvedValue({ sub: userId, email: "campaign-owner@test.example" });
});

/** Wipe campaign state between tests; the fixture user and settings persist. */
async function resetCampaigns(): Promise<void> {
  await prisma.campaignRecipient.deleteMany({});
  await prisma.campaign.deleteMany({});
  await prisma.dailySendCounter.deleteMany({});
  await prisma.leadGroup.deleteMany({});
  await prisma.lead.deleteMany({});
  await prisma.group.deleteMany({});
  await prisma.suppression.deleteMany({});
  await prisma.emailTemplate.deleteMany({});
  await setPermissiveSendSettings(prisma, userId);
}

let seq = 0;
async function freshCampaign(opts: { status?: string } = {}) {
  const account = await createSmtpAccount(prisma, userId);
  const template = await createTemplate(prisma, userId);
  const campaign = await createCampaign(prisma, userId, {
    // "draft" is the only status a campaign can be started FROM besides
    // "stopped" (VALID_TRANSITIONS in the status route), so it is the default
    // here. Ordering tests pass "active" explicitly, because the worker only
    // considers recipients of active campaigns.
    status: opts.status ?? "draft",
    templateId: template.id,
    smtpAccountId: account.id,
  });
  return { account, template, campaign };
}

// ===========================================================================
// 1. Selection order must be deterministic
// ===========================================================================

describe("processDueRecipients — selection order", () => {
  /**
   * Every recipient seeded by one `start` shares a createdAt to the
   * millisecond, which is exactly the situation that produced the stuck
   * recipient: `orderBy: { createdAt: "asc" }` alone is not a total order, so
   * which 10 rows a tick claims is left to the planner.
   */
  it("breaks identical createdAt ties deterministically, lowest id first", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "active" });

    // 25 rows, ALL sharing one timestamp — the tie that matters.
    const sameInstant = new Date("2026-09-28T19:18:39.529Z");
    const rows = await createRecipients(
      prisma,
      campaign.id,
      Array.from({ length: 25 }, (_, i) => ({
        email: `tie-${String(i).padStart(2, "0")}@example.com`,
        createdAt: sameInstant,
      })),
    );

    // Sanity: the fixture really did produce identical timestamps.
    const distinct = new Set(rows.map((r) => r.createdAt.toISOString()));
    expect(distinct.size).toBe(1);

    await worker.processDueRecipients();

    const sent = await prisma.campaignRecipient.findMany({
      where: { campaignId: campaign.id, status: "sent" },
      orderBy: { id: "asc" },
    });

    // Exactly one window of 10.
    expect(sent).toHaveLength(10);

    // Those 10 are the 10 lowest ids — NOT an arbitrary subset.
    const lowestTen = rows.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 10).map((r) => r.id);
    expect(sent.map((r) => r.id)).toEqual(lowestTen);
  });

  it("selects the SAME rows on a repeated identical tick", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "active" });

    const sameInstant = new Date("2026-09-28T19:18:39.529Z");
    const rows = await createRecipients(
      prisma,
      campaign.id,
      Array.from({ length: 25 }, (_, i) => ({
        email: `det-${String(i).padStart(2, "0")}@example.com`,
        createdAt: sameInstant,
      })),
    );

    await worker.processDueRecipients();
    const first = await prisma.campaignRecipient.findMany({
      where: { campaignId: campaign.id, status: "sent" },
      orderBy: { id: "asc" },
      select: { id: true },
    });

    // Rewind the queue to its exact starting state.
    await prisma.campaignRecipient.updateMany({
      where: { campaignId: campaign.id },
      data: { status: "pending", attempts: 0, nextAttemptAt: null, sentAt: null },
    });

    await worker.processDueRecipients();
    const second = await prisma.campaignRecipient.findMany({
      where: { campaignId: campaign.id, status: "sent" },
      orderBy: { id: "asc" },
      select: { id: true },
    });

    expect(first).toHaveLength(10);
    expect(second).toEqual(first);
  });

  /**
   * The actual defect, stated as an outcome: every queued recipient is
   * eventually sent, and in (createdAt, id) order. Under a non-deterministic
   * ORDER BY a row behind an unbreakable tie can be skipped indefinitely.
   */
  it("drains the whole queue in order, starving nobody", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "active" });

    const sameInstant = new Date("2026-09-28T19:18:39.529Z");
    const rows = await createRecipients(
      prisma,
      campaign.id,
      Array.from({ length: 25 }, (_, i) => ({
        email: `drain-${String(i).padStart(2, "0")}@example.com`,
        createdAt: sameInstant,
      })),
    );
    const expected = rows.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => r.id);

    const sendOrder: string[] = [];
    sendSmtpMail.mockImplementation(async (_a: unknown, m: { to: string }) => {
      sendOrder.push(m.to);
      return { messageId: "<m>", accepted: [m.to], rejected: [], response: "250 Ok" };
    });

    // Tick until the queue is empty.
    for (let i = 0; i < 10; i++) {
      const processed = await worker.processDueRecipients();
      if (processed === 0) break;
    }

    const sent = await prisma.campaignRecipient.findMany({
      where: { campaignId: campaign.id, status: "sent" },
      select: { recipient: true },
    });
    expect(sent).toHaveLength(25);

    // Sends happened in exactly the order the rows were seeded (id order),
    // which is the (createdAt, id) order since every createdAt is equal.
    expect(sendOrder).toEqual(expected.map((id) => rows.find((r) => r.id === id)!.recipient));
  });

  it("persists the SMTP Message-ID so a send can be reconciled with server logs", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "active" });
    await createRecipients(prisma, campaign.id, [{ email: "traceable@example.com" }]);

    sendSmtpMail.mockResolvedValue({
      messageId: "<trace-42@mail.example.com>",
      accepted: ["traceable@example.com"],
      rejected: [],
      response: "250 2.0.0 Ok: queued as 7Y8Z9X",
    });

    await worker.processDueRecipients();

    const row = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(row.status).toBe("sent");
    expect(row.googleMessageId).toBe("<trace-42@mail.example.com>");
    // The raw SMTP reply must never reach the database.
    expect(JSON.stringify(row)).not.toContain("7Y8Z9X");
  });

  it("does NOT mark a recipient sent when the server rejected the envelope recipient", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "active" });
    await createRecipients(prisma, campaign.id, [{ email: "refused@example.com" }]);

    // nodemailer RESOLVES in this case — it does not throw — so without an
    // explicit check the recipient would be recorded as delivered.
    sendSmtpMail.mockResolvedValue({
      messageId: "<refused@mail.example.com>",
      accepted: [],
      rejected: ["refused@example.com"],
      response: "550 5.1.1 No such user",
    });

    await worker.processDueRecipients();

    const row = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(row.status).not.toBe("sent");
    expect(row.status).toBe("failed");
    expect(row.sentAt).toBeNull();
    expect(row.googleMessageId).toBeNull();
    expect(row.lastError).toContain("rejected");
    // The credential-shaped detail must not have been stored either.
    expect(row.lastError).not.toContain("550 5.1.1");
  });

  it("orders by createdAt first, and only then breaks ties", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "active" });

    const sameInstant = new Date("2026-09-29T00:00:00.000Z");
    // Deliberately seeded newest-first so insertion order cannot be mistaken
    // for send order.
    const rows = await createRecipients(prisma, campaign.id, [
      { email: "newest-a@example.com", createdAt: sameInstant },
      { email: "newest-b@example.com", createdAt: sameInstant },
      { email: "oldest@example.com", createdAt: new Date("2026-09-28T00:00:00.000Z") },
    ]);

    const sendOrder: string[] = [];
    sendSmtpMail.mockImplementation(async (_a: unknown, m: { to: string }) => {
      sendOrder.push(m.to);
      return { messageId: "<m>", accepted: [m.to], rejected: [], response: "250 Ok" };
    });

    await worker.processDueRecipients();

    // All three fit inside the 10-row window, so this asserts ORDER, not
    // membership: the strictly-older row goes first, and only the
    // equal-timestamp pair is decided by id.
    const expected = rows
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((r) => r.recipient);

    expect(sendOrder).toHaveLength(3);
    expect(sendOrder).toEqual(expected);
    expect(sendOrder[0]).toBe("oldest@example.com");
  });
});

// ===========================================================================
// 2. start() must not erase send history
// ===========================================================================

describe("POST /api/campaigns/[id]/status — start() and send history", () => {
  const ORIGIN = "http://localhost:3000";

  const start = (id: string) =>
    statusRoute.POST(
      new Request(`http://localhost:3000/api/campaigns/${id}/status`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      }),
      { params: { id } },
    );

  const stop = (id: string) =>
    statusRoute.POST(
      new Request(`http://localhost:3000/api/campaigns/${id}/status`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      }),
      { params: { id } },
    );

  const rows = async (campaignId: string) =>
    prisma.campaignRecipient.findMany({ where: { campaignId }, orderBy: { recipient: "asc" } });

  const byEmail = async (campaignId: string) => {
    const list = await rows(campaignId);
    const map: Record<string, (typeof list)[number]> = {};
    for (const r of list) map[r.recipient] = r;
    return map;
  };

  // -- 1. untouched pending recipient ---------------------------------------
  it("re-queues an untouched pending recipient as pending", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign();
    await createLead(prisma, userId, { email: "untouched@example.com" });
    await createRecipients(prisma, campaign.id, [{ email: "untouched@example.com" }]);

    const res = await start(campaign.id);
    expect(res.status).toBe(200);

    const map = await byEmail(campaign.id);
    expect(Object.keys(map)).toEqual(["untouched@example.com"]);
    expect(map["untouched@example.com"].status).toBe("pending");
    expect(map["untouched@example.com"].attempts).toBe(0);
  });

  // -- 2. failed recipient with attempts > 0 --------------------------------
  it("PRESERVES a failed recipient that has attempts > 0", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign();
    await createLead(prisma, userId, { email: "failed@example.com" });
    // A never-attempted lead as well, so the start is valid and this test
    // isolates PRESERVATION. (A campaign whose only recipient is terminally
    // failed is a separate case, covered below.)
    await createLead(prisma, userId, { email: "companion@example.com" });
    const created = await createRecipients(prisma, campaign.id, [
      { email: "failed@example.com", status: "failed", attempts: 3, lastError: "Gave up after 3 attempt(s)" },
    ]);
    const originalId = created[0].id;

    const res = await start(campaign.id);
    expect(res.status).toBe(200);

    const map = await byEmail(campaign.id);
    const row = map["failed@example.com"];
    // Same row, same id, same history — NOT rebuilt as a fresh pending row.
    expect(row.id).toBe(originalId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
    expect(row.lastError).toBe("Gave up after 3 attempt(s)");
    expect(Object.keys(map).sort()).toEqual(["companion@example.com", "failed@example.com"]);
    expect(map["companion@example.com"].status).toBe("pending");
  });

  // -- 3. sending recipient with attempts > 0 -------------------------------
  it("PRESERVES a sending recipient that has attempts > 0", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign();
    await createLead(prisma, userId, { email: "stuck@example.com" });
    const leaseExpiry = new Date("2026-09-29T17:32:33.498Z");
    const created = await createRecipients(prisma, campaign.id, [
      {
        email: "stuck@example.com",
        status: "sending",
        attempts: 1,
        lastError: "Network error (ECONNRESET)",
        nextAttemptAt: leaseExpiry,
      },
    ]);
    const originalId = created[0].id;

    await start(campaign.id);

    const row = (await byEmail(campaign.id))["stuck@example.com"];
    expect(row.id).toBe(originalId);
    expect(row.status).toBe("sending");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("Network error (ECONNRESET)");
    expect(row.nextAttemptAt?.toISOString()).toBe(leaseExpiry.toISOString());
  });

  // -- 4. sent recipient -----------------------------------------------------
  it("leaves a sent recipient completely untouched", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign();
    await createLead(prisma, userId, { email: "done@example.com" });
    const sentAt = new Date("2026-09-29T20:49:08.180Z");
    const created = await createRecipients(prisma, campaign.id, [
      {
        email: "done@example.com",
        status: "sent",
        attempts: 1,
        nextAttemptAt: null,
      },
    ]);
    const originalId = created[0].id;
    await prisma.campaignRecipient.update({ where: { id: originalId }, data: { sentAt } });
    await createLead(prisma, userId, { email: "fresh@example.com" });

    await start(campaign.id);

    const map = await byEmail(campaign.id);
    expect(map["done@example.com"].id).toBe(originalId);
    expect(map["done@example.com"].status).toBe("sent");
    expect(map["done@example.com"].sentAt?.toISOString()).toBe(sentAt.toISOString());
    // Still not re-queued.
    expect(map["fresh@example.com"].status).toBe("pending");
  });

  // -- 5. suppressed recipient -----------------------------------------------
  it("still seeds a suppressed recipient as skipped", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign();
    await createLead(prisma, userId, { email: "blocked@example.com" });
    await createLead(prisma, userId, { email: "allowed@example.com" });
    await prisma.suppression.create({ data: { userId, email: "blocked@example.com" } });

    await start(campaign.id);

    const map = await byEmail(campaign.id);
    expect(map["blocked@example.com"].status).toBe("skipped");
    expect(map["allowed@example.com"].status).toBe("pending");
  });

  // -- 6. stopped -> start ---------------------------------------------------
  it("preserves history across stopped -> start", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "stopped" });
    await createLead(prisma, userId, { email: "carried@example.com" });
    // A second, never-attempted lead, so the start has real work to do and the
    // test isolates PRESERVATION rather than the empty-queue guard.
    await createLead(prisma, userId, { email: "new-work@example.com" });
    const created = await createRecipients(prisma, campaign.id, [
      { email: "carried@example.com", status: "failed", attempts: 2, lastError: "temporary" },
    ]);

    const res = await start(campaign.id);
    expect(res.status).toBe(200);

    const row = (await byEmail(campaign.id))["carried@example.com"];
    expect(row.id).toBe(created[0].id);
    expect(row.attempts).toBe(2);
    expect(row.status).toBe("failed");
    expect((await byEmail(campaign.id))["new-work@example.com"].status).toBe("pending");
    expect((await prisma.campaign.findUnique({ where: { id: campaign.id } }))!.status).toBe("active");
  });

  // -- 7. repeated stop -> start --------------------------------------------
  it("survives repeated stop -> start cycles without duplicating or resetting", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "active" });
    await createLead(prisma, userId, { email: "cycle@example.com" });
    const created = await createRecipients(prisma, campaign.id, [
      { email: "cycle@example.com", status: "sending", attempts: 2, lastError: "flaky" },
    ]);

    for (let i = 0; i < 3; i++) {
      const stopped = await stop(campaign.id);
      expect(stopped.status).toBe(200);
      const started = await start(campaign.id);
      expect(started.status).toBe(200);
    }

    const list = await rows(campaign.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created[0].id);
    expect(list[0].attempts).toBe(2);
    expect(list[0].status).toBe("sending");
  });

  // -- 8. uncertain Gmail send followed by a restart -------------------------
  it("preserves an uncertain Gmail send across a campaign restart", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "stopped" });
    await createLead(prisma, userId, { email: "jfillmore@cpcmds.com" });

    // Reproduces the audited row exactly: claimed once, the provider request
    // died mid-flight, the worker never learned whether it was delivered.
    const gmailError =
      "Network error (ECONNRESET): request to https://gmail.googleapis.com/gmail/v1/users/messages/send failed, reason: socket hang up";
    const createdAt = new Date("2026-09-28T19:18:39.529Z");
    const created = await createRecipients(prisma, campaign.id, [
      {
        email: "jfillmore@cpcmds.com",
        status: "sending",
        attempts: 1,
        lastError: gmailError,
        nextAttemptAt: new Date("2026-09-29T17:32:33.498Z"),
        createdAt,
      },
    ]);

    const res = await start(campaign.id);
    expect(res.status).toBe(200);

    // The row must be the SAME row, carrying the SAME uncertainty.
    const list = await rows(campaign.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created[0].id);
    expect(list[0].status).toBe("sending");
    expect(list[0].attempts).toBe(1);
    expect(list[0].lastError).toBe(gmailError);
    expect(list[0].sentAt).toBeNull();
    expect(list[0].googleMessageId).toBeNull();

    // ...and the operator is told it exists rather than it being silently carried.
    const body = await res.json();
    expect(body.preservedRecipients).toBe(1);
    expect(body.uncertainRecipients).toBe(1);
  });

  // -- 9. retry budget must not silently reset -------------------------------
  it("never resets the retry budget of a recipient that has been attempted", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "stopped" });
    await createLead(prisma, userId, { email: "budget@example.com" });

    // maxRetryAttempts is 3 (see setPermissiveSendSettings). A recipient at 3
    // has spent its whole budget: one more failure must be terminal, not a
    // fresh first attempt.
    const created = await createRecipients(prisma, campaign.id, [
      { email: "budget@example.com", status: "sending", attempts: 3, lastError: "retry 3 of 3" },
    ]);

    await start(campaign.id);
    let row = (await byEmail(campaign.id))["budget@example.com"];
    expect(row.attempts).toBe(3);

    // Second restart: still 3, never silently back to 0.
    await stop(campaign.id);
    await start(campaign.id);
    row = (await byEmail(campaign.id))["budget@example.com"];
    expect(row.id).toBe(created[0].id);
    expect(row.attempts).toBe(3);
  });

  it("mixes preserved rows with newly seeded rows without colliding", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "stopped" });
    for (const email of ["old-attempted@example.com", "old-untouched@example.com"]) {
      await createLead(prisma, userId, { email });
    }
    await createLead(prisma, userId, { email: "brand-new@example.com" });
    await createRecipients(prisma, campaign.id, [
      { email: "old-attempted@example.com", status: "failed", attempts: 2, lastError: "boom" },
      { email: "old-untouched@example.com" },
    ]);

    const res = await start(campaign.id);
    expect(res.status).toBe(200);

    const map = await byEmail(campaign.id);
    expect(Object.keys(map).sort()).toEqual([
      "brand-new@example.com",
      "old-attempted@example.com",
      "old-untouched@example.com",
    ]);
    expect(map["old-attempted@example.com"].status).toBe("failed");
    expect(map["old-attempted@example.com"].attempts).toBe(2);
    expect(map["old-untouched@example.com"].status).toBe("pending");
    expect(map["brand-new@example.com"].status).toBe("pending");

    const body = await res.json();
    expect(body.preservedRecipients).toBe(1);
    expect(body.uncertainRecipients).toBe(0);
  });

  it("still refuses a start when there is genuinely nothing to send", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign();
    // Only a lead exists that is already suppressed → nothing pending.
    await createLead(prisma, userId, { email: "only-suppressed@example.com" });
    await prisma.suppression.create({ data: { userId, email: "only-suppressed@example.com" } });

    const res = await start(campaign.id);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("No valid recipients"),
    });
  });

  /**
   * The deliberate consequence of preserving failed rows: a campaign whose only
   * recipients have already been attempted and terminally failed now refuses to
   * start, instead of silently re-seeding them at attempts=0. Before this fix
   * that campaign would "start" and re-send to addresses that had already
   * exhausted their retry budget.
   */
  it("refuses to re-queue terminally failed recipients instead of resetting them", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "stopped" });
    await createLead(prisma, userId, { email: "exhausted@example.com" });
    const created = await createRecipients(prisma, campaign.id, [
      {
        email: "exhausted@example.com",
        status: "failed",
        attempts: 3,
        lastError: "Gave up after 3 attempt(s): Invalid request rejected (400)",
      },
    ]);

    const res = await start(campaign.id);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("has no retry left");

    // And critically: the history is untouched.
    const row = (await byEmail(campaign.id))["exhausted@example.com"];
    expect(row.id).toBe(created[0].id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
    // The campaign was NOT left active with a re-seeded queue.
    expect((await prisma.campaign.findUnique({ where: { id: campaign.id } }))!.status).toBe("stopped");
  });

  it("allows a start when the only remaining work is already-attempted rows", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "stopped" });
    await createLead(prisma, userId, { email: "only-attempted@example.com" });
    await createRecipients(prisma, campaign.id, [
      { email: "only-attempted@example.com", status: "sending", attempts: 1, lastError: "flaky" },
    ]);

    // Every lead is now also an attempted recipient, so there are zero seeds
    // to create — but there IS legitimate work left, so the start must go
    // through rather than dead-end on the "no valid recipients" guard.
    const res = await start(campaign.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recipients).toBe(1);
    expect(body.preservedRecipients).toBe(1);
  });
});

// ===========================================================================
// 3. Failure logging
// ===========================================================================

describe("send failure logging", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("emits one structured, timestamped entry per retried send", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "active" });
    await createRecipients(prisma, campaign.id, [
      { email: "will-retry@example.com", createdAt: new Date("2026-09-28T19:18:39.529Z") },
    ]);

    sendSmtpMail.mockRejectedValue(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    );

    await worker.processDueRecipients();

    const lines = warn.mock.calls
      .map((c) => c[0])
      .filter((v): v is string => typeof v === "string" && v.startsWith("{"));
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    const row = await prisma.campaignRecipient.findFirst({ where: { campaignId: campaign.id } });

    expect(entry.event).toBe("campaign_send_failure");
    expect(entry.campaignId).toBe(campaign.id);
    expect(entry.recipientId).toBe(row!.id);
    expect(entry.attempt).toBe(1);
    expect(entry.kind).toBe("temporary");
    expect(entry.action).toBe("schedule_retry");
    expect(typeof entry.retryAfterSeconds).toBe("number");
    expect(new Date(entry.ts).toString()).not.toBe("Invalid Date");

    // The recipient's address must NOT be in the log line: a log file must not
    // become a recipient list.
    expect(lines[0]).not.toContain("will-retry@example.com");
  });

  it("never writes a password or token into the log line", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "active" });
    await createRecipients(prisma, campaign.id, [{ email: "leaky@example.com" }]);

    sendSmtpMail.mockRejectedValue(
      new Error(
        "535 5.7.8 Error: authentication failed: user=user@example.com password=hunter2 access_token=ya29.a0AfH6SMB-secret refresh_token=1//refresh-secret",
      ),
    );

    await worker.processDueRecipients();

    const line = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain("campaign_send_failure");
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("ya29.a0AfH6SMB-secret");
    expect(line).not.toContain("1//refresh-secret");
    expect(line).not.toContain("leaky@example.com");
  });

  it("logs a terminal failure with no retry time", async () => {
    await resetCampaigns();
    const { campaign } = await freshCampaign({ status: "active" });
    await createRecipients(prisma, campaign.id, [{ email: "permanent@example.com", attempts: 3 }]);

    sendSmtpMail.mockRejectedValue(
      Object.assign(new Error("invalid_grant"), {}),
    );

    await worker.processDueRecipients();

    const lines = warn.mock.calls
      .map((c) => c[0])
      .filter((v): v is string => typeof v === "string" && v.startsWith("{"));
    const entry = JSON.parse(lines[0]);
    expect(entry.action).toBe("auth_required");
    expect(entry.retryAfterSeconds).toBeNull();
  });
});
