import { describe, it, expect } from "vitest";
import { TokenBucket, SendRateLimiter, effectiveMessagesPerMinute } from "@/lib/rate-limiter";

describe("TokenBucket", () => {
  it("allows capacity tokens immediately", () => {
    const bucket = new TokenBucket(3, 3 / 60, 1000);
    expect(bucket.tryTake(1000)).toBe(true);
    expect(bucket.tryTake(1000)).toBe(true);
    expect(bucket.tryTake(1000)).toBe(true);
    expect(bucket.tryTake(1000)).toBe(false);
  });

  it("refills over time", () => {
    const bucket = new TokenBucket(1, 1, 0); // 1 token/sec
    expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(0)).toBe(false);
    expect(bucket.tryTake(500)).toBe(false);
    expect(bucket.tryTake(1010)).toBe(true);
  });
});

describe("SendRateLimiter", () => {
  const policy = { messagesPerMinute: 3, minDelaySeconds: 2 };

  it("allows first send and blocks immediately after", () => {
    const limiter = new SendRateLimiter();
    expect(limiter.canSend("a", policy, 1000)).toBe(true);
    limiter.recordSend("a", 1000);
    expect(limiter.canSend("a", policy, 1100)).toBe(false); // within min delay
  });

  it("enforces minimum delay", () => {
    const limiter = new SendRateLimiter();
    limiter.recordSend("a", 1000);
    expect(limiter.canSend("a", policy, 2999)).toBe(false);
    expect(limiter.canSend("a", policy, 3000)).toBe(true); // exactly min delay
  });

  it("is per-account", () => {
    const limiter = new SendRateLimiter();
    limiter.recordSend("a", 1000);
    expect(limiter.canSend("b", policy, 1000)).toBe(true);
  });

  it("reports time to next send", () => {
    const limiter = new SendRateLimiter();
    limiter.recordSend("a", 1000);
    expect(limiter.timeToNextSend("a", policy, 1000)).toBe(2000);
    expect(limiter.timeToNextSend("a", policy, 3001)).toBe(0);
  });
});

describe("effectiveMessagesPerMinute", () => {
  it("caps by min delay", () => {
    expect(effectiveMessagesPerMinute({ messagesPerMinute: 10, minDelaySeconds: 20 })).toBe(3);
    expect(effectiveMessagesPerMinute({ messagesPerMinute: 10, minDelaySeconds: 60 })).toBe(1);
    expect(effectiveMessagesPerMinute({ messagesPerMinute: 5, minDelaySeconds: 1 })).toBe(5);
  });
});