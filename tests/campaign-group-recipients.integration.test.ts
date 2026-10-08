/**
 * Campaign recipient source = the SELECTED GROUP, never "all the user's leads".
 *
 * Regression for a production bug: a campaign created against one group
 * (e.g. COLLAB_REV_BATCH_2_formatted, 99 contacts) previewed and looked like it
 * targeted every contact in the account (e.g. 876) because the preview route
 * resolved the audience from `{ userId }` instead of the campaign's
 * `recipientGroupId`. The start route already seeded only the group's members;
 * the preview now resolves the exact same audience, so the two can never
 * disagree again.
 *
 * Runs against a REAL throwaway Postgres (helpers/test-db.ts) — the load-bearing
 * claims are about rows (which leads became CampaignRecipient rows) and
 * ownership (a foreign group is rejected). Only the network is faked:
 * `sendSmtpMail` and the session, exactly like the other campaign integration
 * suites. NO TEST HERE SENDS REAL EMAIL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestDatabase, stopTestDatabase } from "./helpers/test-db";

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

import {
  createUser,
  createSmtpAccount,
  createTemplate,
  createLead,
  createCampaign,
  setPermissiveSendSettings,
} from "./helpers/fixtures";
import type { PrismaClient, Lead } from "@prisma/client";

let prisma: PrismaClient;
let createRoute: typeof import("@/app/api/campaigns/route");
let previewRoute: typeof import("@/app/api/campaigns/[id]/preview/route");
let statusRoute: typeof import("@/app/api/campaigns/[id]/status/route");

let userId: string;
let otherUserId: string;
const ORIGIN = "http://localhost:3000";

beforeAll(async () => {
  await startTestDatabase();
  prisma = (await import("@/lib/prisma")).prisma;
  createRoute = await import("@/app/api/campaigns/route");
  previewRoute = await import("@/app/api/campaigns/[id]/preview/route");
  statusRoute = await import("@/app/api/campaigns/[id]/status/route");
  userId = (await createUser(prisma, "group-owner@test.example")).id;
  otherUserId = (await createUser(prisma, "other-owner@test.example")).id;
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
  getSession.mockResolvedValue({ sub: userId, email: "group-owner@test.example" });
});

/** Wipe campaign/send/group/lead state between tests; fixture users + settings persist. */
async function resetState(): Promise<void> {
  await prisma.campaignRecipient.deleteMany({});
  await prisma.campaignSendingAccount.deleteMany({});
  await prisma.campaign.deleteMany({});
  await prisma.leadGroup.deleteMany({});
  await prisma.lead.deleteMany({});
  await prisma.group.deleteMany({});
  await prisma.suppression.deleteMany({});
  await prisma.emailTemplate.deleteMany({});
  await prisma.smtpAccount.deleteMany({ where: { userId } });
  await prisma.dailySendCounter.deleteMany({});
  await setPermissiveSendSettings(prisma, userId);
}

/** Creates a group row and returns it. */
async function createGroup(name: string, ownerId = userId) {
  return prisma.group.create({ data: { userId: ownerId, name } });
}

/** Creates `count` distinct leads all linked to `groupId`. */
async function leadsInGroup(groupId: string, count: number, prefix: string): Promise<Lead[]> {
  const out: Lead[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      await createLead(prisma, userId, {
        email: `${prefix}-${i}@example.com`,
        groupId,
      }),
    );
  }
  return out;
}

/** A single SMTP mailbox + template, enough to start a campaign. */
async function senderAndTemplate() {
  const smtp = await createSmtpAccount(prisma, userId, { email: "dispatch@test.example" });
  const template = await createTemplate(prisma, userId);
  return { smtp, template };
}

function apiCreate(body: Record<string, unknown>) {
  return createRoute.POST(
    new Request(`${ORIGIN}/api/campaigns`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function apiPreview(id: string) {
  return previewRoute.GET(
    new Request(`${ORIGIN}/api/campaigns/${id}/preview`, { headers: { origin: ORIGIN } }),
    { params: { id } },
  );
}

function start(id: string) {
  return statusRoute.POST(
    new Request(`${ORIGIN}/api/campaigns/${id}/status`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    }),
    { params: { id } },
  );
}

// ===========================================================================
// Core regression: the selected group is the ONLY recipient source
// ===========================================================================

describe("campaign targets the selected group only", () => {
  it("preview counts ONLY the selected group's contacts — never all leads", async () => {
    await resetState();
    // Group A = 3, Group B = 2, Group C = 2, plus 1 contact in no group at all.
    const a = await createGroup("Group A");
    const b = await createGroup("Group B");
    await createGroup("Group C");
    const aLeads = await leadsInGroup(a.id, 3, "group-a");
    await leadsInGroup(b.id, 2, "group-b");
    await createLead(prisma, userId, { email: "ungrouped@example.com" });
    const totalLeads = await prisma.lead.count({ where: { userId } });
    expect(totalLeads).toBe(6); // 3 + 2 + 1 — plenty of "other" contacts.

    const { smtp, template } = await senderAndTemplate();
    const res = await apiCreate({
      name: "Only group A",
      templateId: template.id,
      smtpAccountId: smtp.id,
      recipientGroupId: a.id,
    });
    expect(res.status).toBe(201);
    const { campaign } = await res.json();

    const preview = await apiPreview(campaign.id);
    expect(preview.status).toBe(200);
    const body = await preview.json();

    // The reported audience is EXACTLY group A — anything else is the bug
    // (this used to return `totalLeads`, i.e. 6, not 3).
    expect(body.recipientCount).toBe(3);
    expect(body.recipientCount).not.toBe(totalLeads);
    expect(body.validRecipientCount).toBe(3);
    expect(body.suppressedCount).toBe(0);
    expect(body.duplicatesRemoved).toBe(0);
    const aEmails = new Set(aLeads.map((l) => l.email));
    expect(body.sampleRecipients.length).toBeGreaterThan(0);
    expect(body.sampleRecipients.every((e: string) => aEmails.has(e))).toBe(true);
  });

  it("start seeds recipient rows from the selected group only — send queue excludes other groups and ungrouped leads", async () => {
    await resetState();
    const a = await createGroup("Group A");
    const b = await createGroup("Group B");
    const aLeads = await leadsInGroup(a.id, 4, "queued-a");
    const bLeads = await leadsInGroup(b.id, 2, "queued-b");
    await createLead(prisma, userId, { email: "queued-ungrouped@example.com" });

    const { smtp, template } = await senderAndTemplate();
    const campaign = await createCampaign(prisma, userId, {
      templateId: template.id,
      smtpAccountId: smtp.id,
      groupId: a.id,
    });

    const res = await start(campaign.id);
    expect(res.status).toBe(200);

    const rows = await prisma.campaignRecipient.findMany({
      where: { campaignId: campaign.id },
      include: { lead: true },
    });
    // 4 recipients — the 2 B-leads and the ungrouped lead did NOT leak in.
    expect(rows).toHaveLength(4);
    const aIds = new Set(aLeads.map((l) => l.id));
    expect(rows.every((r) => r.leadId && aIds.has(r.leadId))).toBe(true);
    const rowEmails = new Set(rows.map((r) => r.recipient));
    expect(!Array.from(rowEmails).some((e) => e.includes("queued-b"))).toBe(true);
    expect(Array.from(rowEmails).includes("queued-ungrouped@example.com")).toBe(false);
    expect(rowEmails).toEqual(new Set(aLeads.map((l) => l.email)));
    // Everything was queued as sendable.
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(bLeads).toHaveLength(2);
  });

  it("persists the chosen group as the campaign's recipient source (recipientGroupId)", async () => {
    await resetState();
    const a = await createGroup("COLLAB_REV_BATCH_2_formatted");
    await leadsInGroup(a.id, 3, "source-a");

    const { smtp, template } = await senderAndTemplate();
    const res = await apiCreate({
      name: "Persists source",
      templateId: template.id,
      smtpAccountId: smtp.id,
      recipientGroupId: a.id,
    });
    expect(res.status).toBe(201);
    const { campaign, recipientGroup } = await res.json();

    expect(campaign.recipientGroupId).toBe(a.id);
    expect(recipientGroup).toMatchObject({ id: a.id, name: "COLLAB_REV_BATCH_2_formatted" });
    const row = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(row.recipientGroupId).toBe(a.id);
  });

  it("selecting a DIFFERENT group targets exactly that group (Group B -> only Group B)", async () => {
    await resetState();
    const a = await createGroup("Group A");
    const b = await createGroup("Group B");
    await leadsInGroup(a.id, 3, "b-swap-a");
    const bLeads = await leadsInGroup(b.id, 4, "b-swap-b");
    await createLead(prisma, userId, { email: "b-swap-ungrouped@example.com" });

    const { smtp, template } = await senderAndTemplate();
    const campaign = await createCampaign(prisma, userId, {
      templateId: template.id,
      smtpAccountId: smtp.id,
      groupId: b.id,
    });

    const preview = await apiPreview(campaign.id);
    const body = await preview.json();
    expect(body.recipientCount).toBe(4);
    const bEmails = new Set(bLeads.map((l) => l.email));
    expect(body.sampleRecipients.every((e: string) => bEmails.has(e))).toBe(true);

    const res = await start(campaign.id);
    expect(res.status).toBe(200);
    const rows = await prisma.campaignRecipient.findMany({ where: { campaignId: campaign.id } });
    expect(rows).toHaveLength(4);
    const bIds = new Set(bLeads.map((l) => l.id));
    expect(rows.every((r) => r.leadId && bIds.has(r.leadId))).toBe(true);
  });

  it("a no-group campaign still targets every lead (pre-Groups behaviour unchanged)", async () => {
    await resetState();
    await createGroup("Unused group");
    await createLead(prisma, userId, { email: "fallback-1@example.com" });
    await createLead(prisma, userId, { email: "fallback-2@example.com" });

    const { smtp, template } = await senderAndTemplate();
    const campaign = await createCampaign(prisma, userId, {
      templateId: template.id,
      smtpAccountId: smtp.id,
    });

    const res = await start(campaign.id);
    expect(res.status).toBe(200);
    expect(
      await prisma.campaignRecipient.count({ where: { campaignId: campaign.id } }),
    ).toBe(2);
  });
});

// ===========================================================================
// Ownership + edge cases
// ===========================================================================

describe("group ownership and edge cases", () => {
  it("rejects a group that belongs to another user (404, no data leak)", async () => {
    await resetState();
    const foreign = await createGroup("Other user's group", otherUserId);
    const { smtp, template } = await senderAndTemplate();
    await createLead(prisma, userId, { email: "mine@example.com" });

    const res = await apiCreate({
      name: "Foreign group",
      templateId: template.id,
      smtpAccountId: smtp.id,
      recipientGroupId: foreign.id,
    });
    expect(res.status).toBe(404);
    // Nothing was created.
    expect(await prisma.campaign.count({ where: { userId } })).toBe(0);
  });

  it("rejects an empty group (400) instead of creating an empty or all-leads campaign", async () => {
    await resetState();
    const empty = await createGroup("Empty group");
    await createLead(prisma, userId, { email: "somebody@example.com" });

    const { smtp, template } = await senderAndTemplate();
    const res = await apiCreate({
      name: "Empty group",
      templateId: template.id,
      smtpAccountId: smtp.id,
      recipientGroupId: empty.id,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("has no contacts yet");
    expect(await prisma.campaign.count({ where: { userId } })).toBe(0);
  });

  it("rejects a plural recipientGroupIds instead of silently falling back to all leads", async () => {
    await resetState();
    const a = await createGroup("Group A");
    await leadsInGroup(a.id, 2, "multi-a");
    await createLead(prisma, userId, { email: "multi-other@example.com" });

    const { smtp, template } = await senderAndTemplate();
    const res = await apiCreate({
      name: "Plural groups",
      templateId: template.id,
      smtpAccountId: smtp.id,
      recipientGroupIds: [a.id],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("recipientGroupId");
    expect(await prisma.campaign.count({ where: { userId } })).toBe(0);
  });

  it("dedupes duplicate emails inside the selected group (existing behaviour preserved)", async () => {
    await resetState();
    const a = await createGroup("Group A");
    const b = await createGroup("Group B");
    // Three distinct rows in A, but row "x" and row "dupe" share ONE email.
    const x = await createLead(prisma, userId, { email: "dup@example.com", groupId: a.id });
    const dupe = await createLead(prisma, userId, { email: "DUP@example.com", groupId: a.id });
    await createLead(prisma, userId, { email: "unique-a@example.com", groupId: a.id });
    // The same lead row is ALSO in group B — it must still be seeded exactly once.
    await prisma.leadGroup.create({ data: { groupId: b.id, leadId: x.id } });
    await prisma.leadGroup.create({ data: { groupId: b.id, leadId: dupe.id } });
    await createLead(prisma, userId, { email: "b-only@example.com", groupId: b.id });

    const { smtp, template } = await senderAndTemplate();
    // Selected group = A.
    const campaign = await createCampaign(prisma, userId, {
      templateId: template.id,
      smtpAccountId: smtp.id,
      groupId: a.id,
    });

    const preview = await apiPreview(campaign.id);
    const body = await preview.json();
    // 3 rows in A -> deduped to 2 unique addresses.
    expect(body.recipientCount).toBe(3);
    expect(body.duplicatesRemoved).toBe(1);

    const res = await start(campaign.id);
    expect(res.status).toBe(200);
    const rows = await prisma.campaignRecipient.findMany({ where: { campaignId: campaign.id } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.recipient))).toEqual(
      new Set(["dup@example.com", "unique-a@example.com"]),
    );
  });
});