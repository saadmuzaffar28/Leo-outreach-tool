import { describe, it, expect } from "vitest";
import { classifySendError, computeBackoffSeconds, shouldRetry } from "@/lib/send-queue";

describe("classifySendError", () => {
  it("treats 429 as retryable", () => {
    const info = classifySendError({ code: 429, message: "Quota exceeded" });
    expect(info.retryable).toBe(true);
  });

  it("treats 5xx as retryable", () => {
    expect(classifySendError({ code: 500, message: "backend" }).retryable).toBe(true);
    expect(classifySendError({ code: 503, message: "unavailable" }).retryable).toBe(true);
  });

  it("treats 400 as permanent", () => {
    const info = classifySendError({ code: 400, message: "Invalid attachment header value" });
    expect(info.retryable).toBe(false);
  });

  it("treats 404 as permanent", () => {
    expect(classifySendError({ code: 404, message: "not found" }).retryable).toBe(false);
  });

  it("treats network errors as retryable", () => {
    expect(classifySendError({ code: "ECONNRESET", message: "reset" }).retryable).toBe(true);
    expect(classifySendError({ message: "fetch failed" }).retryable).toBe(true);
  });

  it("treats revoked grants as permanent", () => {
    const info = classifySendError({ code: 400, message: "invalid_grant: Token has been expired" });
    expect(info.retryable).toBe(false);
  });

  it("treats quota-flavored 403s as retryable", () => {
    const info = classifySendError({
      code: 403,
      message: "User rate limit exceeded",
      errors: [{ reason: "rateLimitExceeded" }],
    });
    expect(info.retryable).toBe(true);
  });
});

describe("computeBackoffSeconds", () => {
  it("grows exponentially and never returns 0", () => {
    const b1 = computeBackoffSeconds(1, 60);
    const b2 = computeBackoffSeconds(3, 60);
    expect(b1).toBeGreaterThanOrEqual(1);
    expect(b2).toBeGreaterThan(b1);
  });

  it("caps at max", () => {
    const b = computeBackoffSeconds(20, 60, 3600);
    expect(b).toBeLessThanOrEqual(3600);
  });
});

describe("shouldRetry", () => {
  it("never retries permanent failures", () => {
    expect(shouldRetry({ retryable: false, message: "x", kind: "permanent" }, 0, 5)).toBe(false);
  });

  it("retries retryable failures within budget", () => {
    expect(shouldRetry({ retryable: true, message: "x", kind: "temporary" }, 0, 5)).toBe(true);
    expect(shouldRetry({ retryable: true, message: "x", kind: "temporary" }, 5, 5)).toBe(false);
  });
});