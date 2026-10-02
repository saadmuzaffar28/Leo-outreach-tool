import { describe, it, expect } from "vitest";
import {
  pickReceiver,
  emailDomain,
  normalizeEmail,
  eligibleReceivers,
  pickReceiverPreferCrossDomain,
} from "@/lib/warmup/pool";

const A = { id: "a", email: "a@alpha.example" };
const B = { id: "b", email: "b@beta.example" };
const C = { id: "c", email: "c@beta.example" };
const D = { id: "d", email: "d@delta.example" };
const POOL = [A, B, C, D];

describe("email helpers", () => {
  it("extracts and lowercases the domain", () => {
    expect(emailDomain("User@Example.COM")).toBe("example.com");
    expect(emailDomain("nope")).toBe("");
  });

  it("normalises for comparison", () => {
    expect(normalizeEmail("  User@Example.com ")).toBe("user@example.com");
  });
});

describe("receiver eligibility", () => {
  it("never allows a mailbox to deliver to itself", () => {
    const r = eligibleReceivers(POOL, A);
    expect(r.map((x) => x.id)).not.toContain("a");
  });

  it("blocks self-delivery even if two rows share one address", () => {
    const dupe = { id: "a2", email: "A@alpha.example" };
    const r = eligibleReceivers([A, dupe, B], A);
    expect(r.map((x) => x.id)).not.toContain("a2");
  });

  it("returns an empty list for a one-mailbox pool", () => {
    expect(eligibleReceivers([A], A)).toEqual([]);
  });
});

describe("rotation", () => {
  it("returns null for an empty or single-mailbox pool", () => {
    expect(pickReceiver([], A, 0)).toBeNull();
    expect(pickReceiver([A], A, 0)).toBeNull();
  });

  it("never picks the sender as its own receiver", () => {
    for (let cursor = 0; cursor < 12; cursor++) {
      const r = pickReceiver(POOL, A, cursor);
      expect(r).not.toBeNull();
      expect(r!.id).not.toBe("a");
    }
  });

  it("takes the sender as a member, matching the other pool helpers", () => {
    // Regression: passing a bare id here used to silently allow self-delivery.
    expect(pickReceiver([A, B], A, 0)?.id).toBe("b");
  });

  it("spreads across the pool as the cursor advances", () => {
    const seen = new Set<string>();
    for (let cursor = 0; cursor < 8; cursor++) {
      const r = pickReceiver(POOL, A, cursor);
      if (r) seen.add(r.id);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("is stable for a given cursor (repeatable)", () => {
    expect(pickReceiver(POOL, A, 2)?.id).toBe(pickReceiver(POOL, A, 2)?.id);
  });

  it("handles a negative cursor", () => {
    expect(pickReceiver(POOL, A, -1)).not.toBeNull();
  });
});

describe("cross-domain preference", () => {
  it("prefers a receiver on a different domain when one exists", () => {
    // A is on alpha.example; every other member is on a different domain.
    for (let cursor = 0; cursor < 8; cursor++) {
      const r = pickReceiverPreferCrossDomain(POOL, A, cursor);
      expect(r).not.toBeNull();
      expect(emailDomain(r!.email)).not.toBe("alpha.example");
    }
  });

  it("falls back to a same-domain receiver when that is all there is", () => {
    const sameDomain = [A, { id: "a2", email: "other@alpha.example" }];
    const r = pickReceiverPreferCrossDomain(sameDomain, A, 0);
    expect(r).not.toBeNull();
    expect(r!.id).toBe("a2");
  });

  it("returns null when the sender is alone in the pool", () => {
    expect(pickReceiverPreferCrossDomain([A], A, 0)).toBeNull();
  });

  it("never returns the sender even across many cursors", () => {
    for (let cursor = 0; cursor < 20; cursor++) {
      const r = pickReceiverPreferCrossDomain(POOL, B, cursor);
      expect(r?.id).not.toBe("b");
    }
  });
});