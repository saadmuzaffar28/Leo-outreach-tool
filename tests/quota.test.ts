import { describe, it, expect } from "vitest";
import { dailyKey, isWithinDailyBudget, remainingBudget, isQuotaPaused } from "@/lib/quota";

describe("dailyKey", () => {
  it("formats a UTC calendar day", () => {
    expect(dailyKey(new Date("2026-08-21T12:34:56Z"))).toBe("2026-08-21");
  });
  it("defaults to now", () => {
    expect(dailyKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("remainingBudget", () => {
  it("computes remaining", () => {
    expect(remainingBudget(10, 100)).toBe(90);
  });
  it("never goes negative", () => {
    expect(remainingBudget(150, 100)).toBe(0);
  });
});

describe("isWithinDailyBudget", () => {
  it("allows sends while under the limit", () => {
    expect(isWithinDailyBudget(99, 100)).toBe(true);
    expect(isWithinDailyBudget(100, 100)).toBe(false);
    expect(isWithinDailyBudget(101, 100)).toBe(false);
  });
});

describe("isQuotaPaused", () => {
  it("is false when no pause is set", () => {
    expect(isQuotaPaused(null, new Date("2026-08-21T10:00:00Z"))).toBe(false);
  });
  it("is true while within the pause window", () => {
    const until = new Date("2026-08-21T10:05:00Z");
    expect(isQuotaPaused(until, new Date("2026-08-21T10:02:00Z"))).toBe(true);
  });
  it("is false once the pause window has passed", () => {
    const until = new Date("2026-08-21T10:05:00Z");
    expect(isQuotaPaused(until, new Date("2026-08-21T10:06:00Z"))).toBe(false);
  });
});