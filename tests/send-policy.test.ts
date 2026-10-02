import { describe, it, expect } from "vitest";
import { decideSendError, classifySendError } from "@/lib/send-queue";

const policy = {
  maxRetryAttempts: 5,
  baseRetryDelaySeconds: 60,
  maxRetryDelaySeconds: 3600,
};

describe("classifySendError kind", () => {
  it("classifies 429 as quota", () => {
    expect(classifySendError({ code: 429, message: "Quota exceeded" }).kind).toBe("quota");
  });
  it("classifies quota-flavored 403 as quota", () => {
    expect(
      classifySendError({ code: 403, message: "rateLimitExceeded", errors: [{ reason: "rateLimitExceeded" }] }).kind,
    ).toBe("quota");
  });
  it("classifies invalid_grant as auth", () => {
    expect(classifySendError({ code: 400, message: "invalid_grant: token expired" }).kind).toBe("auth");
  });
  it("classifies network/5xx as temporary", () => {
    expect(classifySendError({ code: "ECONNRESET" }).kind).toBe("temporary");
    expect(classifySendError({ code: 503 }).kind).toBe("temporary");
  });
  it("classifies 400/404 as permanent", () => {
    expect(classifySendError({ code: 400, message: "bad" }).kind).toBe("permanent");
    expect(classifySendError({ code: 404, message: "nf" }).kind).toBe("permanent");
  });
});

describe("decideSendError", () => {
  it("returns quota_backoff for 429", () => {
    const d = decideSendError({ code: 429, message: "Quota exceeded" }, 1, policy);
    expect(d.action).toBe("quota_backoff");
    if (d.action === "quota_backoff") {
      expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(d.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
  });

  it("returns auth_required for revoked grant", () => {
    const d = decideSendError({ code: 400, message: "invalid_grant: Token has been expired" }, 0, policy);
    expect(d.action).toBe("auth_required");
  });

  it("schedules retries for temporary errors within budget", () => {
    const d = decideSendError({ code: 503, message: "unavailable" }, 1, policy);
    expect(d.action).toBe("schedule_retry");
    if (d.action === "schedule_retry") {
      expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });

  it("backoff grows with attempts", () => {
    const first = decideSendError({ code: 503, message: "x" }, 1, policy);
    const later = decideSendError({ code: 503, message: "x" }, 4, policy);
    if (first.action === "schedule_retry" && later.action === "schedule_retry") {
      expect(later.retryAfterSeconds).toBeGreaterThanOrEqual(first.retryAfterSeconds);
    }
  });

  it("fails permanently once retry budget is exhausted", () => {
    const d = decideSendError({ code: 503, message: "x" }, policy.maxRetryAttempts, policy);
    expect(d.action).toBe("fail_permanent");
  });

  it("fails permanently for permanent errors", () => {
    const d = decideSendError({ code: 400, message: "Invalid argument" }, 0, policy);
    expect(d.action).toBe("fail_permanent");
  });

  it("respects custom retry budget", () => {
    const tight = { ...policy, maxRetryAttempts: 2 };
    expect(decideSendError({ code: 503 }, 2, tight).action).toBe("fail_permanent");
    expect(decideSendError({ code: 503 }, 1, tight).action).toBe("schedule_retry");
  });
});