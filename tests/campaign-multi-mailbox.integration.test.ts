/**
 * Campaign multi-mailbox selection + equal contact distribution — integration.
 *
 * Runs against a REAL throwaway Postgres (helpers/test-db.ts): the load-bearing
 * claims of this feature are about rows and transactions — that every recipient
 * gets a frozen mailbox assignment written once at `start`, that a restart only
 * ever re-seeds rows that were NEVER attempted (preserving the assignments of
 * sent/attempted rows), and that the worker reads that frozen column forever
 * instead of recalculating a rotation. No mock can demonstrate those; only real
 * rows can.
 *
 * Only the network is faked: `sendSmtpMail` (the session for the routes too).
 * The start route, PATCH route, worker, distribution helper and Prisma are all
 * the real code.
 *
 * NO TEST HERE SENDS REAL EMAIL. `sendSmtpMail` is mocked module-wide.
 * No warm-up code is touched. Nothing in this file points at the production
 * database (test-db.ts always boots its own throwaway cluster).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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
import type { PrismaClient, CampaignRecipient } from "@prisma/client";

let prisma: PrismaClient;
let worker: typeof import("@/lib/worker");
let statusRoute: typeof import("@/app/api/campaigns/[id]/status/route");
let createRoute: typeof import("@/app/api/campaigns/route");
let detailRoute: typeof import("@/app/api/campaigns/[id]/route");
let smtpDetailRoute: typeof import("@/app/api/smtp/accounts/[id]/route");

let userId: string;

beforeAll(async () => {
  await startTestDatabase();
  prisma = (await import("@/lib/prisma")).prisma;
  worker = await import("@/lib/worker");
  statusRoute = await import("@/app/api/campaigns/[id]/status/route");
  createRoute = await import("@/app/api/campaigns/route");
  detailRoute = await import("@/app/api/campaigns/[id]/route");
  smtpDetailRoute = await import("@/app/api/smtp/accounts/[id]/route");
  userId = (await createUser(prisma, "multi-mailbox-owner@test.example")).id;
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
  getSession.mockResolvedValue({ sub: userId, email: "multi-mailbox-owner@test.example" });
});

/** Wipe campaign/send state between tests; the fixture user + settings persist. */
async function resetCampaigns(): Promise<void> {
  await prisma.campaignRecipient.deleteMany({});
  await prisma.campaignSendingAccount.deleteMany({});
  await prisma.campaign.deleteMany({});
  await prisma.googleAccount.deleteMany({ where: { userId } });
  await prisma.smtpAccount.deleteMany({ where: { userId } });
  await prisma.dailySendCounter.deleteMany({});
  await prisma.leadGroup.deleteMany({});
  await prisma.lead.deleteMany({});
  await prisma.group.deleteMany({});
  await prisma.suppression.deleteMany({});
  await prisma.emailTemplate.deleteMany({});
  await setPermissiveSendSettings(prisma, userId);
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

const ORIGIN = "http://localhost:3000";

function start(id: string) {
  return statusRoute.POST(
    new Request(`http://localhost:3000/api/campaigns/${id}/status`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    }),
    { params: { id } },
  );
}

function stop(id: string) {
  return statusRoute.POST(
    new Request(`http://localhost:3000/api/campaigns/${id}/status`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    }),
    { params: { id } },
  );
}

function apiCreate(body: Record<string, unknown>) {
  return createRoute.POST(
    new Request("http://localhost:3000/api/campaigns", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function apiPatch(id: string, body: Record<string, unknown>) {
  return detailRoute.PATCH(
    new Request(`http://localhost:3000/api/campaigns/${id}`, {
      method: "PATCH",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: { id } },
  );
}

/** Three connected mailboxes with recognizable emails, sender names + signatures. */
async function mailboxes() {
  const a = await createSmtpAccount(prisma, userId, {
    email: "lucas@collabrevsolution.org",
    displayName: "Lucas",
  });
  const b = await createSmtpAccount(prisma, userId, {
    email: "scott@collabrevsolutions.online",
    displayName: "Scott",
  });
  // Mailbox C deliberately has NO display name -> the sending path falls back
  // to the email's local part ("Gamma").
  const c = await createSmtpAccount(prisma, userId, { email: "gamma@test.example" });
  await prisma.smtpAccount.update({
    where: { id: a.id },
    data: { signatureEnabled: true, signatureHtml: "<p>SIG-LUCAS</p>" },
  });
  await prisma.smtpAccount.update({
    where: { id: b.id },
    data: { signatureEnabled: true, signatureHtml: "<p>SIG-SCOTT</p>" },
  });
  return { a, b, c };
}

/** Creates `n` leads with DISTINCT createdAt so lead order is unambiguous. */
async function staggeredLeads(n: number, prefix = "lead") {
  const leads = [];
  for (let i = 0; i < n; i++) {
    leads.push(
      await prisma.lead.create({
        data: {
          userId,
          email: `${prefix}-${String(i).padStart(3, "0")}@example.com`,
          firstName: "Test",
          lastName: "Lead",
          createdAt: new Date(2026, 0, 1, 0, i, 0, 0),
        },
      }),
    );
  }
  return leads;
}

type RecipientRow = CampaignRecipient & {
  lead: { id: string; createdAt: Date; email: string } | null;
  smtpAccount: { id: string; email: string } | null;
};

async function recipientsOf(campaignId: string): Promise<RecipientRow[]> {
  const rows = await prisma.campaignRecipient.findMany({
    where: { campaignId },
    include: {
      lead: { select: { id: true, createdAt: true, email: true } },
      smtpAccount: { select: { id: true, email: true } },
    },
  });
  return rows as RecipientRow[];
}

/** Recipient rows in the exact deterministic seed order (lead createdAt, id). */
function byLeadOrder(rows: RecipientRow[]): RecipientRow[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        (a.lead?.createdAt.getTime() ?? 0) - (b.lead?.createdAt.getTime() ?? 0) ||
        (a.lead && b.lead ? (a.lead.id < b.lead.id ? -1 : 1) : 0),
    );
}

/** Per-mailbox recipient counts, keyed by SmtpAccount id. */
async function countsByMailbox(campaignId: string): Promise<Map<string, number>> {
  const grouped = await prisma.campaignRecipient.groupBy({
    by: ["smtpAccountId"],
    where: { campaignId },
    _count: { _all: true },
  });
  return new Map(grouped.map((r) => [r.smtpAccountId ?? "__null__", r._count._all]));
}

/** Captures the SMTP config (∴ the mailbox) + html + fromName per outgoing send. */
function captureSends() {
  const calls: Array<{ email: string; to: string; html: string; fromName: string }> = [];
  sendSmtpMail.mockImplementation(
    async (a: unknown, m: { to: string; html?: string; fromName?: string }) => {
      calls.push({
        email: (a as { email: string }).email,
        to: m.to,
        html: m.html ?? "",
        fromName: m.fromName ?? "",
      });
      return { messageId: "<m>", accepted: [m.to], rejected: [], response: "250 Ok" };
    },
  );
  return calls;
}

// ===========================================================================
// 1. Equal, deterministic distribution written at start
// ===========================================================================

describe("start — equal distribution of contacts", () => {
  it("100 contacts / 3 mailboxes -> 34, 33, 33 (every contact assigned exactly once)", async () => {
    await resetCampaigns();
    const { a, b, c } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
      sendingAccounts: [
        { smtpAccountId: a.id, position: 0 },
        { smtpAccountId: b.id, position: 1 },
        { smtpAccountId: c.id, position: 2 },
      ],
    });
    for (let i = 0; i < 100; i++) {
      await createLead(prisma, userId, { email: `bulk-${String(i).padStart(3, "0")}@example.com` });
    }

    const res = await start(campaign.id);
    expect(res.status).toBe(200);

    const counts = await countsByMailbox(campaign.id);
    expect(counts.get(a.id)).toBe(34);
    expect(counts.get(b.id)).toBe(33);
    expect(counts.get(c.id)).toBe(33);
    const total = Array.from(counts.values()).reduce((s, n) => s + n, 0);
    expect(total).toBe(100);

    // No recipient is assigned to more than one mailbox (implicit in 1:1 rows),
    // and every recipient row exists exactly once.
    expect(await prisma.campaignRecipient.count({ where: { campaignId: campaign.id } })).toBe(100);
  });

  it("preserves lead order: round-robin A, B, C for 10 staggered leads", async () => {
    await resetCampaigns();
    const { a, b, c } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
      sendingAccounts: [
        { smtpAccountId: a.id, position: 0 },
        { smtpAccountId: b.id, position: 1 },
        { smtpAccountId: c.id, position: 2 },
      ],
    });
    await staggeredLeads(10);

    const res = await start(campaign.id);
    expect(res.status).toBe(200);

    const ordered = byLeadOrder(await recipientsOf(campaign.id));
    expect(ordered.map((r) => r.smtpAccountId)).toEqual([
      a.id, b.id, c.id,
      a.id, b.id, c.id,
      a.id, b.id, c.id,
      a.id,
    ]);
    // Balanced: A=4, B=3, C=3.
    expect(ordered.filter((r) => r.smtpAccountId === a.id)).toHaveLength(4);
    expect(ordered.filter((r) => r.smtpAccountId === b.id)).toHaveLength(3);
    expect(ordered.filter((r) => r.smtpAccountId === c.id)).toHaveLength(3);
  });

  it("more mailboxes than contacts -> early mailboxes get one, later get zero", async () => {
    await resetCampaigns();
    const { a, b, c } = await mailboxes();
    const d = await createSmtpAccount(prisma, userId, { email: "delta@test.example" });
    const e = await createSmtpAccount(prisma, userId, { email: "epsilon@test.example" });
    const template = await createTemplate(prisma, userId);
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
      sendingAccounts: [a, b, c, d, e].map((m, i) => ({ smtpAccountId: m.id, position: i })),
    });
    await createLead(prisma, userId, { email: "few-a@example.com" });
    await createLead(prisma, userId, { email: "few-b@example.com" });

    await start(campaign.id);

    const counts = await countsByMailbox(campaign.id);
    expect(counts.get(a.id)).toBe(1);
    expect(counts.get(b.id)).toBe(1);
    expect(counts.get(c.id) ?? 0).toBe(0);
    expect(counts.get(d.id) ?? 0).toBe(0);
    expect(counts.get(e.id) ?? 0).toBe(0);
  });

  it("suppressed contacts still occupy a deterministic assignment slot", async () => {
    await resetCampaigns();
    const { a, b, c } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
      sendingAccounts: [
        { smtpAccountId: a.id, position: 0 },
        { smtpAccountId: b.id, position: 1 },
        { smtpAccountId: c.id, position: 2 },
      ],
    });
    const leads = await staggeredLeads(3, "skip");
    await prisma.suppression.create({ data: { userId, email: leads[2].email } });

    await start(campaign.id);

    const ordered = byLeadOrder(await recipientsOf(campaign.id));
    expect(ordered[0].status).toBe("pending");
    expect(ordered[0].smtpAccountId).toBe(a.id);
    expect(ordered[1].status).toBe("pending");
    expect(ordered[1].smtpAccountId).toBe(b.id);
    // The suppressed lead keeps its slot (index 2 -> mailbox C) and is SKIPPED.
    expect(ordered[2].status).toBe("skipped");
    expect(ordered[2].smtpAccountId).toBe(c.id);
  });

  it("hydrates a legacy single-mailbox campaign into the join table at start", async () => {
    await resetCampaigns();
    const { a } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    // Legacy shape: smtpAccountId set, NO sendingAccounts rows.
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
    });
    await staggeredLeads(3);

    await start(campaign.id);

    const joins = await prisma.campaignSendingAccount.findMany({
      where: { campaignId: campaign.id },
      orderBy: { position: "asc" },
    });
    expect(joins).toHaveLength(1);
    expect(joins[0].smtpAccountId).toBe(a.id);
    // Assignments written per recipient — every row points at the legacy account.
    const ordered = byLeadOrder(await recipientsOf(campaign.id));
    expect(ordered.every((r) => r.smtpAccountId === a.id)).toBe(true);
  });
});

// ===========================================================================
// 2. Restart stability — the frozen assignment is never re-rotated
// ===========================================================================

describe("restart stability", () => {
  it("shares assignments across a stopped -> start cycle for untouched rows", async () => {
    await resetCampaigns();
    const { a, b } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
      sendingAccounts: [
        { smtpAccountId: a.id, position: 0 },
        { smtpAccountId: b.id, position: 1 },
      ],
    });
    const leads = await staggeredLeads(6, "cycle");

    await start(campaign.id);
    const first = byLeadOrder(await recipientsOf(campaign.id));

    // Give two rows send history: one SENT, one FAILED with attempts.
    await prisma.campaignRecipient.update({ where: { id: first[0].id }, data: { status: "sent", attempts: 1, sentAt: new Date() } });
    await prisma.campaignRecipient.update({ where: { id: first[1].id }, data: { status: "failed", attempts: 2, lastError: "boom" } });

    await stop(campaign.id);
    const res = await start(campaign.id);
    expect(res.status).toBe(200);

    const second = byLeadOrder(await recipientsOf(campaign.id));

    // Sent/attempted rows are THE SAME ROWS with the same frozen mailbox.
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].smtpAccountId).toBe(first[0].smtpAccountId);
    expect(second[1].id).toBe(first[1].id);
    expect(second[1].smtpAccountId).toBe(first[1].smtpAccountId);

    // Untouched rows keep the same email -> mailbox mapping (deterministic).
    for (const email of [2, 3, 4, 5]) {
      const before = first[email];
      const after = second[email];
      expect(after.lead?.email).toBe(before.lead?.email);
      expect(after.smtpAccountId).toBe(before.smtpAccountId);
      expect(after.status).toBe("pending");
      expect(after.attempts).toBe(0);
    }
    expect(leads).toHaveLength(6);
  });

  it("keeps the same assignment on a repeated worker tick (simulated restart)", async () => {
    await resetCampaigns();
    const { a, b } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
      sendingAccounts: [
        { smtpAccountId: a.id, position: 0 },
        { smtpAccountId: b.id, position: 1 },
      ],
    });
    for (let i = 0; i < 25; i++) {
      await createLead(prisma, userId, { email: `tick-${String(i).padStart(2, "0")}@example.com` });
    }
    await start(campaign.id);

    const byEmailToMailbox = new Map<string, string>();
    const firstPass = captureSends();
    await worker.processDueRecipients();
    for (const c of firstPass) byEmailToMailbox.set(c.to, c.email);

    // Rewind the queue to its exact pre-tick state, WITHOUT touching smtpAccountId.
    await prisma.campaignRecipient.updateMany({
      where: { campaignId: campaign.id },
      data: { status: "pending", attempts: 0, nextAttemptAt: null, sentAt: null },
    });

    const secondPass = captureSends();
    await worker.processDueRecipients();
    expect(secondPass.length).toBeGreaterThan(0);

    for (const c of secondPass) {
      expect(c.email, `mailbox changed between ticks for ${c.to}`).toBe(byEmailToMailbox.get(c.to));
    }
  });
});

// ===========================================================================
// 3. Worker behaviour — send through the frozen mailbox, retries, signatures
// ===========================================================================

describe("worker sends", () => {
  it("sends every recipient through its frozen mailbox", async () => {
    await resetCampaigns();
    const { a, b, c } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
      sendingAccounts: [
        { smtpAccountId: a.id, position: 0 },
        { smtpAccountId: b.id, position: 1 },
        { smtpAccountId: c.id, position: 2 },
      ],
    });
    await staggeredLeads(9, "frozen");
    await start(campaign.id);

    const sends = captureSends();
    await worker.processDueRecipients();
    expect(sends).toHaveLength(9);

    const ordered = byLeadOrder(await recipientsOf(campaign.id));
    ordered.forEach((r, i) => {
      // The send used exactly the config of the mailbox frozen on the row.
      expect(sends[i].email).toBe(r.smtpAccount!.email);
      expect(sends[i].to).toBe(r.lead!.email);
    });
  });

  it("retries use the SAME mailbox — a failure never re-routes the recipient", async () => {
    await resetCampaigns();
    const { a, b, c } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
      sendingAccounts: [
        { smtpAccountId: a.id, position: 0 },
        { smtpAccountId: b.id, position: 1 },
        { smtpAccountId: c.id, position: 2 },
      ],
    });
    const leads = await staggeredLeads(3, "retry");
    await start(campaign.id);
    const ordered = byLeadOrder(await recipientsOf(campaign.id));
    const victim = ordered[0];
    // The victim is on mailbox A — which carries SIG-LUCAS.
    expect(victim.smtpAccountId).toBe(a.id);

    const sends: Array<{ email: string; to: string; html: string; fromName: string }> = [];
    let firstAttempt = true;
    sendSmtpMail.mockImplementation(async (cfg: unknown, m: { to: string; html?: string; fromName?: string }) => {
      const c = cfg as { email: string };
      const html = m.html ?? "";
      sends.push({ email: c.email, to: m.to, html, fromName: m.fromName ?? "" });
      if (firstAttempt && m.to === leads[0].email) {
        firstAttempt = false;
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      }
      return { messageId: "<m>", accepted: [m.to], rejected: [], response: "250 Ok" };
    });

    await worker.processDueRecipients();
    // First tick: victim failed (temporary), the other two sent.
    const retried = await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: victim.id } });
    expect(retried.status).toBe("sending");
    expect(retried.attempts).toBe(1);

    // Advance the retry lease and tick again.
    await prisma.campaignRecipient.update({ where: { id: victim.id }, data: { nextAttemptAt: new Date(2020, 0, 1) } });
    await worker.processDueRecipients();

    const done = await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: victim.id } });
    expect(done.status).toBe("sent");
    expect(done.attempts).toBe(2);
    // The mailbox never changed across the retry.
    expect(done.smtpAccountId).toBe(victim.smtpAccountId);

    const victimSends = sends.filter((s) => s.to === leads[0].email);
    expect(victimSends).toHaveLength(2);
    expect(victimSends[0].email).toBe(a.email);
    expect(victimSends[1].email).toBe(a.email);
    // The signature is Lucas's, on BOTH attempts.
    expect(victimSends[0].html).toContain("SIG-LUCAS");
    expect(victimSends[1].html).toContain("SIG-LUCAS");
    expect(victimSends[0].html).not.toContain("SIG-SCOTT");
    // The sender NAME is Lucas's on the retry too — identity never switches.
    expect(victimSends[0].fromName).toBe("Lucas");
    expect(victimSends[1].fromName).toBe("Lucas");
  });

  it("each recipient's From sender name comes from its frozen mailbox", async () => {
    await resetCampaigns();
    const { a, b, c } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
      sendingAccounts: [
        { smtpAccountId: a.id, position: 0 },
        { smtpAccountId: b.id, position: 1 },
        { smtpAccountId: c.id, position: 2 },
      ],
    });
    await staggeredLeads(9, "fromname");
    await start(campaign.id);

    const sends = captureSends();
    await worker.processDueRecipients();
    expect(sends).toHaveLength(9);

    const ordered = byLeadOrder(await recipientsOf(campaign.id));
    const nameOf = (mailboxEmail: string | null): string => {
      if (mailboxEmail === a.email) return "Lucas";
      if (mailboxEmail === b.email) return "Scott";
      return "Gamma"; // mailbox C has no display name -> local-part fallback
    };
    ordered.forEach((r, i) => {
      // The From name matches the SAME mailbox that authenticated the send —
      // never the campaign name, creator name, template name or a global default.
      expect(sends[i].email).toBe(r.smtpAccount!.email);
      expect(sends[i].fromName).toBe(nameOf(r.smtpAccount!.email));
    });
    // Every one of the three mailboxes actually appears.
    expect(new Set(sends.map((s) => s.fromName))).toEqual(
      new Set(["Lucas", "Scott", "Gamma"]),
    );
  });

  it("uses the signature of the mailbox each recipient was assigned to", async () => {
    await resetCampaigns();
    const { a, b, c } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
      sendingAccounts: [
        { smtpAccountId: a.id, position: 0 },
        { smtpAccountId: b.id, position: 1 },
        { smtpAccountId: c.id, position: 2 },
      ],
    });
    await staggeredLeads(9, "sig");
    await start(campaign.id);

    const sends: Array<{ email: string; to: string; html: string }> = [];
    sendSmtpMail.mockImplementation(async (cfg: unknown, m: { to: string; html?: string }) => {
      sends.push({ email: (cfg as { email: string }).email, to: m.to, html: m.html ?? "" });
      return { messageId: "<m>", accepted: [m.to], rejected: [], response: "250 Ok" };
    });

    await worker.processDueRecipients();

    const ordered = byLeadOrder(await recipientsOf(campaign.id));
    ordered.forEach((r, i) => {
      const html = sends[i].html;
      if (r.smtpAccountId === a.id) {
        expect(html, `recipient on mailbox A missing Lucas's signature`).toContain("SIG-LUCAS");
        expect(html).not.toContain("SIG-SCOTT");
      } else if (r.smtpAccountId === b.id) {
        expect(html, `recipient on mailbox B missing Scott's signature`).toContain("SIG-SCOTT");
        expect(html).not.toContain("SIG-LUCAS");
      } else {
        // Mailbox C has no signature enabled.
        expect(html).not.toContain("SIG-LUCAS");
        expect(html).not.toContain("SIG-SCOTT");
      }
    });
  });

  it("legacy one-account campaigns still send through Campaign.smtpAccount", async () => {
    await resetCampaigns();
    const { a } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    // Pre-feature shape: one account, no join rows, recipients WITHOUT a frozen
    // mailbox column (created directly, exactly like rows written by the old
    // start route).
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
    });
    await staggeredLeads(3, "legacy");
    // Simulate the old world: recipient rows exist but carry no per-recipient
    // mailbox column (exactly what pre-feature rows looked like).
    const leads = await prisma.lead.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take: 3 });
    for (const lead of leads) {
      await prisma.campaignRecipient.create({
        data: { campaignId: campaign.id, leadId: lead.id, recipient: lead.email, status: "pending", attempts: 0 },
      });
    }
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "active" } });

    const sends = captureSends();
    await worker.processDueRecipients();
    expect(sends).toHaveLength(3);
    // All three send through the campaign-level account.
    expect(sends.every((s) => s.email === a.email)).toBe(true);
    // The rows are untouched — no mailbox column was written back.
    const rows = await recipientsOf(campaign.id);
    expect(rows.every((r) => r.smtpAccountId === null)).toBe(true);
  });
});

// ===========================================================================
// 4. Create + edit API — selection before start, blocked after start
// ===========================================================================

describe("campaign create/edit API", () => {
  it("POST accepts a multi-mailbox selection and persists it in order", async () => {
    await resetCampaigns();
    const { a, b, c } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    await createLead(prisma, userId, { email: "create-target@example.com" });

    const res = await apiCreate({
      name: "Multi mailbox",
      templateId: template.id,
      // Deliberately out of creation order: selection order is what matters.
      smtpAccountIds: [c.id, a.id, b.id],
    });
    expect(res.status).toBe(201);
    const { campaign } = await res.json();

    expect(campaign.smtpAccountId).toBe(c.id); // first mailbox mirrored into the legacy column

    const joins = await prisma.campaignSendingAccount.findMany({
      where: { campaignId: campaign.id },
      orderBy: { position: "asc" },
    });
    expect(joins.map((j) => j.smtpAccountId)).toEqual([c.id, a.id, b.id]);

    // The mirrored first mailbox also keeps the existing list/detail reads intact.
    const fetched = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(fetched.smtpAccountId).toBe(c.id);
  });

  it("POST rejects a disconnected mailbox as newly selectable", async () => {
    await resetCampaigns();
    const { a } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    const down = await createSmtpAccount(prisma, userId, {
      email: "down@test.example",
      status: "disconnected",
    });
    await createLead(prisma, userId, { email: "create-target-2@example.com" });

    const res = await apiCreate({
      name: "Has down mailbox",
      templateId: template.id,
      smtpAccountIds: [a.id, down.id],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not connected");
  });

  it("POST rejects mixing SMTP mailboxes with a Gmail account", async () => {
    await resetCampaigns();
    const { a } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    await prisma.googleAccount.create({
      data: {
        userId,
        googleEmail: "gmail-sender@test.example",
        accessTokenEncrypted: "not-a-token",
        refreshTokenEncrypted: "not-a-refresh",
      },
    });
    await createLead(prisma, userId, { email: "create-target-3@example.com" });

    const res = await apiCreate({
      name: "Mixed",
      templateId: template.id,
      smtpAccountIds: [a.id],
      googleAccountId: (await prisma.googleAccount.findFirstOrThrow()).id,
    });
    expect(res.status).toBe(400);
  });

  it("PATCH on a draft replaces the selection", async () => {
    await resetCampaigns();
    const { a, b, c } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
      sendingAccounts: [{ smtpAccountId: a.id, position: 0 }],
    });

    const res = await apiPatch(campaign.id, { smtpAccountIds: [b.id, c.id] });
    expect(res.status).toBe(200);

    const joins = await prisma.campaignSendingAccount.findMany({
      where: { campaignId: campaign.id },
      orderBy: { position: "asc" },
    });
    expect(joins.map((j) => j.smtpAccountId)).toEqual([b.id, c.id]);
    const fetched = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(fetched.smtpAccountId).toBe(b.id); // first mailbox re-mirrored
    expect(fetched.googleAccountId).toBeNull();
    expect(fetched.microsoftAccountId).toBeNull();
  });

  it("PATCH on a stopped campaign is allowed and never rewrites assigned recipients", async () => {
    await resetCampaigns();
    const { a, b, c } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
      sendingAccounts: [
        { smtpAccountId: a.id, position: 0 },
        { smtpAccountId: b.id, position: 1 },
      ],
    });
    await staggeredLeads(4, "edit");
    await start(campaign.id);
    const before = byLeadOrder(await recipientsOf(campaign.id));
    await stop(campaign.id);

    const res = await apiPatch(campaign.id, { smtpAccountIds: [c.id] });
    expect(res.status).toBe(200);

    const after = byLeadOrder(await recipientsOf(campaign.id));
    // Frozen assignments intact — nothing already assigned was rewritten.
    expect(after.map((r) => r.smtpAccountId)).toEqual(before.map((r) => r.smtpAccountId));
    // Only the NEXT start's selection changed.
    const joins = await prisma.campaignSendingAccount.findMany({ where: { campaignId: campaign.id } });
    expect(joins.map((j) => j.smtpAccountId)).toEqual([c.id]);
  });

  it("PATCH on an active campaign is rejected", async () => {
    await resetCampaigns();
    const { a, b } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
      sendingAccounts: [{ smtpAccountId: a.id, position: 0 }],
    });
    await createLead(prisma, userId, { email: "active-target@example.com" });
    await start(campaign.id);
    expect((await prisma.campaign.findUnique({ where: { id: campaign.id } }))!.status).toBe("active");

    const res = await apiPatch(campaign.id, { smtpAccountIds: [a.id, b.id] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("can only be changed before a campaign starts");

    // The selection was NOT changed.
    const joins = await prisma.campaignSendingAccount.findMany({ where: { campaignId: campaign.id } });
    expect(joins.map((j) => j.smtpAccountId)).toEqual([a.id]);
  });

  it("PATCH rejects an empty mailbox selection", async () => {
    await resetCampaigns();
    const { a } = await mailboxes();
    const template = await createTemplate(prisma, userId);
    const campaign = await createCampaign(prisma, userId, {
      status: "draft",
      templateId: template.id,
      smtpAccountId: a.id,
      sendingAccounts: [{ smtpAccountId: a.id, position: 0 }],
    });

    const res = await apiPatch(campaign.id, { smtpAccountIds: [] });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// 5. Gmail/Outlook campaigns are untouched
// ===========================================================================

describe("Gmail campaigns stay on the platform account", () => {
  it("recipients are seeded with no SMTP assignment", async () => {
    await resetCampaigns();
    const template = await createTemplate(prisma, userId);
    const google = await prisma.googleAccount.create({
      data: {
        userId,
        googleEmail: "gmail-platform@test.example",
        accessTokenEncrypted: "not-a-token",
        refreshTokenEncrypted: "not-a-refresh",
      },
    });
    await createLead(prisma, userId, { email: "gmail-target@example.com" });

    const res = await apiCreate({
      name: "Gmail platform",
      templateId: template.id,
      googleAccountId: google.id,
    });
    expect(res.status).toBe(201);
    const { campaign } = await res.json();

    await start(campaign.id);

    const rows = await prisma.campaignRecipient.findMany({ where: { campaignId: campaign.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].smtpAccountId).toBeNull();
    expect(await prisma.campaignSendingAccount.count({ where: { campaignId: campaign.id } })).toBe(0);
    // The worker's pickRecipientSender keeps resolving to the Gmail account —
    // the platform campaign never touches an SMTP mailbox.
    const fetched = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(fetched.googleAccountId).toBe(google.id);
    expect(fetched.smtpAccountId).toBeNull();
  });
});

// ===========================================================================
// 6. SMTP account API — per-mailbox sender name
// ===========================================================================

describe("smtp account sender-name API", () => {
  it("PATCH stores a sender name via the account endpoint", async () => {
    await resetCampaigns();
    const a = await createSmtpAccount(prisma, userId, { email: "lucas@collabrevsolution.org" });

    // displayName-only PATCH: no connection fields, so NO live SMTP test runs.
    const res = await smtpDetailRoute.PATCH(
      new Request(`http://localhost:3000/api/smtp/accounts/${a.id}`, {
        method: "PATCH",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Lucas" }),
      }),
      { params: Promise.resolve({ id: a.id }) },
    );
    expect(res.status).toBe(200);
    const { account } = await res.json();
    expect(account.displayName).toBe("Lucas");
    expect(account.email).toBe("lucas@collabrevsolution.org");

    const row = await prisma.smtpAccount.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.displayName).toBe("Lucas");
    // A displayName-only edit is not a connection change, so connection state
    // is left untouched (no lastTestedAt re-stamp, still connected).
    expect(row.status).toBe("connected");
  });

  it("clearing the sender name resets it to NULL (local-part fallback takes over)", async () => {
    await resetCampaigns();
    const a = await createSmtpAccount(prisma, userId, {
      email: "scott@collabrevsolutions.online",
      displayName: "Scott",
    });

    const res = await smtpDetailRoute.PATCH(
      new Request(`http://localhost:3000/api/smtp/accounts/${a.id}`, {
        method: "PATCH",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ displayName: "" }),
      }),
      { params: Promise.resolve({ id: a.id }) },
    );
    expect(res.status).toBe(200);
    const row = await prisma.smtpAccount.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.displayName).toBeNull();
  });

  it("CR/LF header-injection in a sender name is neutralised at the API boundary", async () => {
    await resetCampaigns();
    const a = await createSmtpAccount(prisma, userId, { email: "scott@collabrevsolutions.online" });

    const res = await smtpDetailRoute.PATCH(
      new Request(`http://localhost:3000/api/smtp/accounts/${a.id}`, {
        method: "PATCH",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Scott\r\nBcc: attacker@example.com" }),
      }),
      { params: Promise.resolve({ id: a.id }) },
    );
    expect(res.status).toBe(200);
    const row = await prisma.smtpAccount.findUniqueOrThrow({ where: { id: a.id } });
    // Stored single-line; the email address and credentials are untouched.
    expect(row.displayName).toBe("Scott Bcc: attacker@example.com");
    expect(row.displayName).not.toContain("\r");
    expect(row.displayName).not.toContain("\n");
    expect(row.email).toBe("scott@collabrevsolutions.online");
  });
});