import { describe, expect, it } from "vitest";
import {
  distributeRecipientsAcrossAccounts,
  distributionCounts,
} from "@/lib/campaign-distribution";
import { pickRecipientSender } from "@/lib/campaigns";
import { campaignCreateSchema, campaignUpdateSchema } from "@/lib/validation";

// ---------------------------------------------------------------------------
// distributionCounts / distributeRecipientsAcrossAccounts
// ---------------------------------------------------------------------------

const A = "account-a";
const B = "account-b";
const C = "account-c";

function counts(recipientCount: number, accountIds: string[]) {
  return distributionCounts(recipientCount, accountIds).map((c) => c.count);
}

function recipients(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
}

describe("distributionCounts — balanced round-robin", () => {
  it("100 contacts / 10 mailboxes -> 10 each", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const result = counts(100, ids);
    expect(result).toHaveLength(10);
    expect(result.every((n) => n === 10)).toBe(true);
    expect(result.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("100 contacts / 4 mailboxes -> 25 each", () => {
    const ids = ["m0", "m1", "m2", "m3"];
    expect(counts(100, ids)).toEqual([25, 25, 25, 25]);
  });

  it("100 contacts / 3 mailboxes -> 34, 33, 33", () => {
    expect(counts(100, [A, B, C])).toEqual([34, 33, 33]);
  });

  it("101 contacts / 10 mailboxes -> 11, then 10 each", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const result = counts(101, ids);
    expect(result[0]).toBe(11);
    expect(result.slice(1).every((n) => n === 10)).toBe(true);
    expect(result.reduce((a, b) => a + b, 0)).toBe(101);
  });

  it("balanced: no two mailboxes differ by more than 1", () => {
    for (const [n, k] of [
      [1000, 7],
      [101, 10],
      [37, 5],
      [12, 9],
      [2, 11],
    ] as const) {
      const ids = Array.from({ length: k }, (_, i) => `m${i}`);
      const result = counts(n, ids);
      const min = Math.min(...result);
      const max = Math.max(...result);
      expect(max - min, `${n}/${k}`).toBeLessThanOrEqual(1);
      expect(result.reduce((a, b) => a + b, 0)).toBe(n);
    }
  });

  it("5 contacts / 10 mailboxes -> five mailboxes get one each, five get zero", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    expect(counts(5, ids)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  });

  it("1 contact / 10 mailboxes -> first mailbox gets one, rest zero", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    expect(counts(1, ids)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("0 contacts -> no counts consumed, every account zero", () => {
    expect(counts(0, [A, B])).toEqual([0, 0]);
  });

  it("no mailboxes -> empty result", () => {
    expect(distributionCounts(100, [])).toEqual([]);
  });

  it("duplicate mailbox ids are deduplicated, never double-counted", () => {
    expect(counts(10, [A, A, B, A])).toEqual([5, 5]);
  });
});

describe("distributeRecipientsAcrossAccounts", () => {
  it("100 recipients / 10 mailboxes -> each recipient assigned exactly once", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const { accountByRecipient, counts } = distributeRecipientsAcrossAccounts(recipients(100), ids);
    expect(accountByRecipient).toHaveLength(100);
    expect(accountByRecipient.every((a) => a !== null)).toBe(true);
    expect(counts.map((c) => c.count)).toEqual(ids.map(() => 10));
  });

  it("preserves recipient order (round-robin by index)", () => {
    const { accountByRecipient } = distributeRecipientsAcrossAccounts(recipients(10), [A, B, C]);
    expect(accountByRecipient).toEqual([A, B, C, A, B, C, A, B, C, A]);
    // Shared deterministic helper matches the task's reference example:
    // account A -> recipients 1, 4, 7, 10; B -> 2, 5, 8; C -> 3, 6, 9.
    expect(accountByRecipient.filter((a) => a === A)).toHaveLength(4);
    expect(accountByRecipient.filter((a) => a === B)).toHaveLength(3);
    expect(accountByRecipient.filter((a) => a === C)).toHaveLength(3);
  });

  it("more mailboxes than recipients -> unused mailboxes get zero (no empty rows)", () => {
    const ids = ["m0", "m1", "m2", "m3", "m4"];
    const { accountByRecipient, counts } = distributeRecipientsAcrossAccounts(recipients(3), ids);
    expect(accountByRecipient).toEqual(["m0", "m1", "m2"]);
    expect(counts.map((c) => c.count)).toEqual([1, 1, 1, 0, 0]);
  });

  it("0 recipients -> no assignments", () => {
    const { accountByRecipient, counts } = distributeRecipientsAcrossAccounts([], [A, B]);
    expect(accountByRecipient).toEqual([]);
    expect(counts.map((c) => c.count)).toEqual([0, 0]);
  });

  it("no mailboxes selected -> every recipient gets null (worker falls back)", () => {
    const { accountByRecipient } = distributeRecipientsAcrossAccounts(recipients(5), []);
    expect(accountByRecipient).toEqual([null, null, null, null, null]);
  });

  it("duplicate selection does not duplicate assignment", () => {
    const { accountByRecipient, counts } = distributeRecipientsAcrossAccounts(recipients(4), [A, A, B]);
    // [A, A, B] dedupes to [A, B]; the 4 recipients round-robin on the deduped
    // selection -> A, B, A, B. Duplicates never multiply assignment slots.
    expect(accountByRecipient).toEqual([A, B, A, B]);
    expect(counts).toEqual([
      { smtpAccountId: A, count: 2 },
      { smtpAccountId: B, count: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// pickRecipientSender — which mailbox actually sends (worker decision rule)
// ---------------------------------------------------------------------------

const smtpA = { id: "smtp-a" };
const smtpB = { id: "smtp-b" };
const ms = { id: "ms-1" };
const g = { id: "g-1" };

describe("pickRecipientSender", () => {
  it("the recipient's frozen mailbox assignment wins over everything", () => {
    expect(
      pickRecipientSender({
        recipientSmtp: smtpA,
        campaignSmtp: smtpB,
        campaignMicrosoft: ms,
        campaignGoogle: g,
      }),
    ).toEqual({ kind: "smtp", accountId: "smtp-a" });
  });

  it("no frozen assignment -> campaign-level SMTP account (legacy single-mailbox)", () => {
    expect(
      pickRecipientSender({
        recipientSmtp: null,
        campaignSmtp: smtpB,
        campaignMicrosoft: null,
        campaignGoogle: g,
      }),
    ).toEqual({ kind: "smtp", accountId: "smtp-b" });
  });

  it("outlook campaign (no smtp) -> microsoft", () => {
    expect(
      pickRecipientSender({
        recipientSmtp: null,
        campaignSmtp: null,
        campaignMicrosoft: ms,
        campaignGoogle: null,
      }),
    ).toEqual({ kind: "microsoft", accountId: "ms-1" });
  });

  it("gmail campaign (no smtp) -> google", () => {
    expect(
      pickRecipientSender({
        recipientSmtp: null,
        campaignSmtp: null,
        campaignMicrosoft: null,
        campaignGoogle: g,
      }),
    ).toEqual({ kind: "google", accountId: "g-1" });
  });

  it("no account at all -> null (recipient fails, never silently re-routes)", () => {
    expect(
      pickRecipientSender({
        recipientSmtp: null,
        campaignSmtp: null,
        campaignMicrosoft: null,
        campaignGoogle: null,
      }),
    ).toBeNull();
  });

  it("restart-safety: the frozen assignment is stable regardless of campaign state", () => {
    // A worker restart re-reads the row; the decision must be identical every
    // time because it depends only on the frozen column, never on a counter.
    const row = {
      recipientSmtp: smtpA,
      campaignSmtp: smtpB,
      campaignMicrosoft: ms,
      campaignGoogle: g,
    };
    for (let i = 0; i < 5; i++) {
      expect(pickRecipientSender(row)).toEqual({ kind: "smtp", accountId: "smtp-a" });
    }
  });
});

// ---------------------------------------------------------------------------
// Validation — the account-selection contract
// ---------------------------------------------------------------------------

const base = { name: "Campaign", templateId: "tpl-1" };

describe("campaignCreateSchema — sending-mailbox selection", () => {
  it("requires at least one sending mailbox", () => {
    const parsed = campaignCreateSchema.safeParse({ ...base });
    expect(parsed.success).toBe(false);
  });

  it("accepts multiple SMTP mailboxes", () => {
    const parsed = campaignCreateSchema.safeParse({ ...base, smtpAccountIds: ["a", "b", "c"] });
    expect(parsed.success).toBe(true);
  });

  it("accepts the legacy single smtpAccountId field", () => {
    const parsed = campaignCreateSchema.safeParse({ ...base, smtpAccountId: "a" });
    expect(parsed.success).toBe(true);
  });

  it("accepts exactly one Gmail or Outlook account", () => {
    expect(campaignCreateSchema.safeParse({ ...base, googleAccountId: "g1" }).success).toBe(true);
    expect(campaignCreateSchema.safeParse({ ...base, microsoftAccountId: "m1" }).success).toBe(true);
  });

  it("rejects combining SMTP mailboxes with a Gmail/Outlook account", () => {
    const parsed = campaignCreateSchema.safeParse({ ...base, smtpAccountIds: ["a"], googleAccountId: "g1" });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty mailbox selections", () => {
    const parsed = campaignCreateSchema.safeParse({ ...base, smtpAccountIds: [] });
    expect(parsed.success).toBe(false);
  });
});

describe("campaignUpdateSchema — editing the selection before start", () => {
  it("accepts templateId, smtpAccountIds, or both", () => {
    expect(campaignUpdateSchema.safeParse({ templateId: "t2" }).success).toBe(true);
    expect(campaignUpdateSchema.safeParse({ smtpAccountIds: ["a", "b"] }).success).toBe(true);
    expect(campaignUpdateSchema.safeParse({ templateId: "t2", smtpAccountIds: ["a"] }).success).toBe(true);
  });

  it("rejects an empty body and an empty mailbox list", () => {
    expect(campaignUpdateSchema.safeParse({}).success).toBe(false);
    expect(campaignUpdateSchema.safeParse({ smtpAccountIds: [] }).success).toBe(false);
  });
});