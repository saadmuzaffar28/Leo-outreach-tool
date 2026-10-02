import { describe, it, expect } from "vitest";
import { isSuppressed, signUnsubscribe, verifyUnsubscribe } from "@/lib/suppression";

describe("isSuppressed", () => {
  it("matches regardless of case", () => {
    expect(isSuppressed("OptOut@Example.com", new Set(["optout@example.com"]))).toBe(true);
    expect(isSuppressed("other@example.com", new Set(["optout@example.com"]))).toBe(false);
  });
});

describe("unsubscribe signatures", () => {
  it("signs and verifies correctly", () => {
    const sig = signUnsubscribe("user-1", "lead@example.com");
    expect(verifyUnsubscribe("user-1", "lead@example.com", sig)).toBe(true);
  });

  it("is bound to the user", () => {
    const sig = signUnsubscribe("user-1", "lead@example.com");
    expect(verifyUnsubscribe("user-2", "lead@example.com", sig)).toBe(false);
  });

  it("is bound to the email", () => {
    const sig = signUnsubscribe("user-1", "lead@example.com");
    expect(verifyUnsubscribe("user-1", "other@example.com", sig)).toBe(false);
  });

  it("rejects tampered signatures", () => {
    const sig = signUnsubscribe("user-1", "lead@example.com");
    expect(verifyUnsubscribe("user-1", "lead@example.com", sig.slice(0, -1) + "0")).toBe(false);
  });
});