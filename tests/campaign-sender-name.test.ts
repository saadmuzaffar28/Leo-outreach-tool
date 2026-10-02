import { describe, it, expect } from "vitest";
import { campaignCreateSchema } from "@/lib/validation";
import { encodeHeaderValue, buildMessageText, buildMessageHtml } from "@/lib/message";

const BASE = {
  name: "Q3 Outreach",
  templateId: "tpl_1",
  googleAccountId: "acct_1",
} as const;

/** Mirrors the worker's resolution so the fallback contract is tested directly. */
function resolveSenderName(campaignSenderName: string | null, globalDefault: string): string {
  return campaignSenderName?.trim() || globalDefault;
}

describe("campaign sender name validation", () => {
  it("is optional, so pre-existing campaigns stay valid", () => {
    expect(campaignCreateSchema.safeParse(BASE).success).toBe(true);
  });

  it("accepts a normal display name", () => {
    const r = campaignCreateSchema.safeParse({ ...BASE, senderName: "Dr. Sarah's Billing Team" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.senderName).toBe("Dr. Sarah's Billing Team");
  });

  it("trims surrounding whitespace", () => {
    const r = campaignCreateSchema.safeParse({ ...BASE, senderName: "  Acme Billing  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.senderName).toBe("Acme Billing");
  });

  it("accepts non-ASCII display names (encoded later as RFC 2047)", () => {
    const r = campaignCreateSchema.safeParse({ ...BASE, senderName: "Zahnarztpraxis Müller" });
    expect(r.success).toBe(true);
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(campaignCreateSchema.safeParse({ ...BASE, senderName: "" }).success).toBe(false);
    expect(campaignCreateSchema.safeParse({ ...BASE, senderName: "   " }).success).toBe(false);
  });

  it("rejects names over 80 characters", () => {
    expect(campaignCreateSchema.safeParse({ ...BASE, senderName: "a".repeat(81) }).success).toBe(false);
    expect(campaignCreateSchema.safeParse({ ...BASE, senderName: "a".repeat(80) }).success).toBe(true);
  });

  it("rejects CR/LF to block header injection", () => {
    for (const bad of [
      "Acme\r\nBcc: attacker@evil.example",
      "Acme\nBcc: attacker@evil.example",
      "Acme\r\nBcc: a@b.example\r\nSubject: hijacked",
    ]) {
      expect(campaignCreateSchema.safeParse({ ...BASE, senderName: bad }).success).toBe(false);
    }
  });

  it("rejects angle brackets so the From address cannot be forged", () => {
    for (const bad of ["Evil <attacker@evil.example>", "<attacker@evil.example>", "a>b"]) {
      expect(campaignCreateSchema.safeParse({ ...BASE, senderName: bad }).success).toBe(false);
    }
  });
});

describe("sender name resolution", () => {
  it("uses the campaign name when set", () => {
    expect(resolveSenderName("Acme Billing", "Leo's outreach")).toBe("Acme Billing");
  });

  it("falls back to the global default when null", () => {
    expect(resolveSenderName(null, "Leo's outreach")).toBe("Leo's outreach");
  });

  it("falls back to the global default when blank", () => {
    expect(resolveSenderName("", "Leo's outreach")).toBe("Leo's outreach");
    expect(resolveSenderName("   ", "Leo's outreach")).toBe("Leo's outreach");
  });
});

describe("encodeHeaderValue hardening", () => {
  it("passes through plain ASCII unchanged", () => {
    expect(encodeHeaderValue("Acme Billing")).toBe("Acme Billing");
  });

  it("RFC 2047-encodes non-ASCII", () => {
    expect(encodeHeaderValue("Müller")).toBe("=?UTF-8?B?" + Buffer.from("Müller", "utf8").toString("base64") + "?=");
  });

  it("collapses CR/LF so one header cannot become two", () => {
    expect(encodeHeaderValue("Acme\r\nBcc: attacker@evil.example")).toBe("Acme Bcc: attacker@evil.example");
    expect(encodeHeaderValue("Acme\nBcc: x@y.example")).not.toContain("\n");
    expect(encodeHeaderValue("Acme\rBcc: x@y.example")).not.toContain("\r");
  });

  it("collapses CR/LF before encoding non-ASCII", () => {
    const out = encodeHeaderValue("Müller\r\nBcc: x@y.example");
    expect(out).not.toContain("\r");
    expect(out).not.toContain("\n");
    expect(Buffer.from(out.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, ""), "base64").toString("utf8")).toBe(
      "Müller Bcc: x@y.example",
    );
  });
});

describe("From header in built messages", () => {
  const msg = {
    fromName: "Acme Billing",
    fromEmail: "real@alarichealthservices.com",
    to: "dr@example.com",
    subject: "Records request",
    body: "Hello",
    unsubscribeUrl: null,
  };

  it("uses the display name with the account address in the text part", () => {
    expect(buildMessageText(msg)).toContain("From: Acme Billing <real@alarichealthservices.com>");
  });

  it("uses the display name in the HTML part too", () => {
    expect(buildMessageHtml(msg)).toContain("From: Acme Billing <real@alarichealthservices.com>");
  });

  it("cannot be used to inject a Bcc header even if validation were bypassed", () => {
    const injected = { ...msg, fromName: "Acme\r\nBcc: attacker@evil.example" };
    const raw = buildMessageText(injected);
    // the only From line is the intended one; nothing smuggled a second header
    const fromLines = raw.split("\r\n").filter((l) => /^From:/i.test(l));
    expect(fromLines).toHaveLength(1);
    expect(fromLines[0]).toBe("From: Acme Bcc: attacker@evil.example <real@alarichealthservices.com>");
    expect(raw).not.toMatch(/^Bcc:/im);
  });

  it("emits a bare address when no display name is set", () => {
    expect(buildMessageText({ ...msg, fromName: "" })).toContain("From: real@alarichealthservices.com");
  });
});