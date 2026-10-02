import { describe, it, expect } from "vitest";
import {
  targetForDay,
  nextRampDay,
  parseHhMm,
  isWithinWindow,
  pickDelaySeconds,
  warmupAllowance,
  isRampComplete,
  rampLength,
} from "@/lib/warmup/ramp";

describe("daily ramp", () => {
  const cfg = { startingDailyVolume: 5, dailyIncrease: 1, maximumDailyVolume: 15 };

  it("matches the specified day-1..day-4 example", () => {
    expect(targetForDay(1, cfg)).toBe(5);
    expect(targetForDay(2, cfg)).toBe(6);
    expect(targetForDay(3, cfg)).toBe(7);
    expect(targetForDay(4, cfg)).toBe(8);
  });

  it("keeps increasing until the maximum, then clamps", () => {
    expect(targetForDay(5, cfg)).toBe(9);
    expect(targetForDay(10, cfg)).toBe(14);
    expect(targetForDay(11, cfg)).toBe(15);
    expect(targetForDay(12, cfg)).toBe(15);
    expect(targetForDay(999, cfg)).toBe(15);
  });

  it("never returns below the starting volume", () => {
    expect(targetForDay(0, cfg)).toBe(5);
    expect(targetForDay(-50, cfg)).toBe(5);
  });

  it("handles a larger daily increase", () => {
    const fast = { startingDailyVolume: 5, dailyIncrease: 4, maximumDailyVolume: 25 };
    expect(targetForDay(1, fast)).toBe(5);
    expect(targetForDay(2, fast)).toBe(9);
    expect(targetForDay(3, fast)).toBe(13);
    expect(targetForDay(6, fast)).toBe(25);
    expect(targetForDay(7, fast)).toBe(25);
  });

  it("handles a zero increase (flat ramp)", () => {
    const flat = { startingDailyVolume: 5, dailyIncrease: 0, maximumDailyVolume: 15 };
    expect(targetForDay(1, flat)).toBe(5);
    expect(targetForDay(9, flat)).toBe(5);
  });

  it("never exceeds the maximum even if start already exceeds it", () => {
    const odd = { startingDailyVolume: 50, dailyIncrease: 1, maximumDailyVolume: 15 };
    expect(targetForDay(1, odd)).toBe(15);
  });
});

describe("ramp day progression", () => {
  it("starts at day 1 on the first ever run", () => {
    expect(nextRampDay(0, false)).toBe(1);
  });

  it("stays on the same day when it already ran today", () => {
    expect(nextRampDay(3, true)).toBe(3);
  });

  it("advances when it has not run today", () => {
    expect(nextRampDay(3, false)).toBe(4);
  });

  it("does not advance multiple days after a long pause", () => {
    // Two days paused then resumed: one advance, not three.
    expect(nextRampDay(3, false)).toBe(4);
  });
});

describe("ramp completion + length", () => {
  const cfg = { startingDailyVolume: 5, dailyIncrease: 1, maximumDailyVolume: 15 };

  it("is not complete on day 1", () => {
    expect(isRampComplete(1, cfg)).toBe(false);
  });

  it("is complete once the target reaches the maximum", () => {
    expect(isRampComplete(10, cfg)).toBe(false);
    expect(isRampComplete(11, cfg)).toBe(true);
    expect(isRampComplete(12, cfg)).toBe(true);
  });

  it("computes the number of ramp days", () => {
    expect(rampLength(cfg)).toBe(11); // 5,6,7,...,15
    expect(rampLength({ startingDailyVolume: 5, dailyIncrease: 5, maximumDailyVolume: 15 })).toBe(3);
    expect(rampLength({ startingDailyVolume: 5, dailyIncrease: 0, maximumDailyVolume: 15 })).toBe(1);
  });
});

describe("warm-up window", () => {
  it("parses HH:mm", () => {
    expect(parseHhMm("09:00")).toBe(540);
    expect(parseHhMm("17:30")).toBe(1050);
    expect(parseHhMm("00:00")).toBe(0);
    expect(parseHhMm("23:59")).toBe(1439);
  });

  it("rejects malformed times", () => {
    expect(parseHhMm("24:00")).toBeNull();
    expect(parseHhMm("9:60")).toBeNull();
    expect(parseHhMm("nope")).toBeNull();
    expect(parseHhMm("")).toBeNull();
  });

  it("allows sends inside a normal same-day window", () => {
    const at = (h: number, m: number) => new Date(2026, 0, 1, h, m);
    expect(isWithinWindow(at(9, 0), "09:00", "17:00")).toBe(true);
    expect(isWithinWindow(at(12, 30), "09:00", "17:00")).toBe(true);
    expect(isWithinWindow(at(8, 59), "09:00", "17:00")).toBe(false);
    expect(isWithinWindow(at(17, 0), "09:00", "17:00")).toBe(false);
    expect(isWithinWindow(at(23, 0), "09:00", "17:00")).toBe(false);
  });

  it("supports a window that wraps past midnight", () => {
    const at = (h: number, m: number) => new Date(2026, 0, 1, h, m);
    expect(isWithinWindow(at(23, 0), "22:00", "06:00")).toBe(true);
    expect(isWithinWindow(at(2, 0), "22:00", "06:00")).toBe(true);
    expect(isWithinWindow(at(12, 0), "22:00", "06:00")).toBe(false);
    expect(isWithinWindow(at(6, 0), "22:00", "06:00")).toBe(false);
  });

  it("treats a zero-width window as unrestricted", () => {
    expect(isWithinWindow(new Date(2026, 0, 1, 3, 0), "09:00", "09:00")).toBe(true);
  });

  it("fails OPEN on a malformed window rather than wedging the mailbox shut", () => {
    expect(isWithinWindow(new Date(2026, 0, 1, 3, 0), "bad", "17:00")).toBe(true);
  });
});

describe("delays", () => {
  it("stays within the configured bounds", () => {
    for (let i = 0; i < 200; i++) {
      const d = pickDelaySeconds(60, 120);
      expect(d).toBeGreaterThanOrEqual(60);
      expect(d).toBeLessThanOrEqual(120);
    }
  });

  it("swaps inverted bounds instead of producing nonsense", () => {
    for (let i = 0; i < 50; i++) {
      const d = pickDelaySeconds(120, 60);
      expect(d).toBeGreaterThanOrEqual(60);
      expect(d).toBeLessThanOrEqual(120);
    }
  });

  it("returns the bound when min == max", () => {
    expect(pickDelaySeconds(45, 45)).toBe(45);
  });

  it("never returns a negative delay", () => {
    expect(pickDelaySeconds(-10, -5)).toBeGreaterThanOrEqual(0);
  });
});

describe("shared quota allowance", () => {
  const cfg = { startingDailyVolume: 5, dailyIncrease: 1, maximumDailyVolume: 15 };

  it("is capped by the ramp target", () => {
    // target 5, nothing sent, plenty of budget -> 5
    expect(warmupAllowance(20, 0, targetForDay(1, cfg))).toBe(5);
  });

  it("shrinks as warm-up sends consume its target", () => {
    expect(warmupAllowance(20, 2, targetForDay(1, cfg))).toBe(3);
    expect(warmupAllowance(20, 5, targetForDay(1, cfg))).toBe(0);
  });

  it("is capped by the SHARED budget, which campaigns also draw from", () => {
    // dailyLimit 20, campaigns already used 15 -> only 5 left in total
    expect(warmupAllowance(5, 0, targetForDay(1, cfg))).toBe(5);
    // campaigns used 18 -> 2 left
    expect(warmupAllowance(2, 0, targetForDay(1, cfg))).toBe(2);
    // campaigns used 20 -> 0 left, warm-up gets nothing
    expect(warmupAllowance(0, 0, targetForDay(1, cfg))).toBe(0);
  });

  it("never allows warm-up plus campaigns to exceed the daily limit", () => {
    // The exact scenario from the requirement: limit 20, warm-up 8 -> 12 left.
    const limit = 20;
    const warmupUsed = 8;
    const campaignUsed = 8;
    const budgetLeft = limit - (warmupUsed + campaignUsed);
    const allowed = warmupAllowance(budgetLeft, warmupUsed, 100);
    expect(allowed).toBe(4); // 20 - 8 - 8
    expect(warmupUsed + campaignUsed + allowed).toBeLessThanOrEqual(limit);
  });

  it("never returns a negative allowance", () => {
    expect(warmupAllowance(0, 10, 5)).toBe(0);
    expect(warmupAllowance(-5, 0, 5)).toBe(0);
  });
});