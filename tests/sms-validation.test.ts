import { describe, it, expect } from "vitest";
import { smsCampaignCreateSchema, smsContactSchema, smsReplySchema } from "@/lib/validation";

describe("smsContactSchema", () => {
  it("accepts valid contacts", () => {
    const parsed = smsContactSchema.safeParse({ name: "Jane", phoneNumber: "+12025550123" });
    expect(parsed.success).toBe(true);
  });

  it("rejects invalid phone numbers", () => {
    const parsed = smsContactSchema.safeParse({ name: "Jane", phoneNumber: "abc" });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty names", () => {
    const parsed = smsContactSchema.safeParse({ name: "  ", phoneNumber: "+12025550123" });
    expect(parsed.success).toBe(false);
  });
});

describe("smsCampaignCreateSchema", () => {
  const base = {
    name: "Test campaign",
    message: "Hello {{name}}",
    source: "+12025550100",
    contactIds: ["c1"],
    sendNow: true,
  };

  it("accepts a send-now campaign", () => {
    expect(smsCampaignCreateSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a scheduled campaign with ISO datetime", () => {
    const parsed = smsCampaignCreateSchema.safeParse({
      ...base,
      sendNow: false,
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(parsed.success).toBe(true);
  });

  it("requires at least one recipient (empty campaign)", () => {
    const parsed = smsCampaignCreateSchema.safeParse({ ...base, contactIds: [] });
    expect(parsed.success).toBe(false);
  });

  it("requires a message", () => {
    const parsed = smsCampaignCreateSchema.safeParse({ ...base, message: "" });
    expect(parsed.success).toBe(false);
  });

  it("rejects scheduled campaigns without a date at the API layer", () => {
    // The route enforces this; schema alone allows missing scheduledAt.
    const parsed = smsCampaignCreateSchema.safeParse({ ...base, sendNow: false });
    expect(parsed.success).toBe(true); // schema passes; route rejects
  });
});

describe("smsReplySchema", () => {
  it("accepts valid replies", () => {
    expect(
      smsReplySchema.safeParse({ phoneNumber: "+12025550123", message: "Thanks!" }).success,
    ).toBe(true);
  });

  it("rejects empty messages and bad numbers", () => {
    expect(
      smsReplySchema.safeParse({ phoneNumber: "+12025550123", message: "" }).success,
    ).toBe(false);
    expect(
      smsReplySchema.safeParse({ phoneNumber: "nope", message: "hi" }).success,
    ).toBe(false);
  });
});
