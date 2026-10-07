/**
 * Pure unit tests for the verification vocabulary — no DB, no network.
 *
 * These cover the deterministic pieces of the feature (normalize, parse,
 * scoring, gate policy, logging, loopback guard, backoff), so a failure is
 * a logic bug and nothing else.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  isPlausibleEmail,
  normalizeOrNull,
  parseEmailList,
} from "@/lib/verification/normalize";
import { computeConfidence } from "@/lib/verification/scoring";
import {
  blockedStatuses,
  decideGate,
  isVerificationPolicy,
  coercePolicy,
  policyDescription,
  VERIFICATION_BLOCKED_PREFIX,
} from "@/lib/verification/gate";
import { maskEmail } from "@/lib/verification/log";
import { isLoopbackServiceUrl } from "@/lib/verification/engine";
import { backoffSeconds } from "@/lib/verification/worker";
import type { VerificationStatus } from "@/lib/verification/types";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  John.Doe@Example.COM ")).toBe("john.doe@example.com");
  });
});

describe("isPlausibleEmail / normalizeOrNull", () => {
  it("accepts a normal address", () => {
    expect(isPlausibleEmail("a@b.co")).toBe(true);
    expect(normalizeOrNull(" A@B.CO ")).toBe("a@b.co");
  });
  it("rejects garbage", () => {
    expect(isPlausibleEmail("not-an-email")).toBe(false);
    expect(isPlausibleEmail("a@b")).toBe(false);
    expect(isPlausibleEmail("")).toBe(false);
    expect(isPlausibleEmail("a b@c.com")).toBe(false);
    expect(normalizeOrNull("nope")).toBeNull();
  });
});

describe("parseEmailList", () => {
  it("splits on commas, semicolons, tabs and newlines", () => {
    const out = parseEmailList("a@x.com, b@y.com;c@z.com\td@w.io\n e@v.co ");
    expect(out.emails).toEqual(["a@x.com", "b@y.com", "c@z.com", "d@w.io", "e@v.co"]);
    expect(out.invalid).toBe(0);
    expect(out.duplicates).toBe(0);
  });

  it("normalizes + dedupes, first occurrence wins", () => {
    const out = parseEmailList("A@X.com\na@x.com\nA@X.com");
    expect(out.emails).toEqual(["a@x.com"]);
    expect(out.duplicates).toBe(2);
  });

  it("counts invalid entries and tolerates an email column header", () => {
    const out = parseEmailList("Email\nnot-an-email\na@x.com\na@x.com");
    expect(out.emails).toEqual(["a@x.com"]);
    expect(out.invalid).toBe(1);
    expect(out.duplicates).toBe(1);
  });

  it("handles empty input", () => {
    expect(parseEmailList("")).toEqual({ emails: [], duplicates: 0, invalid: 0 });
    expect(parseEmailList("  \n  ")).toEqual({ emails: [], duplicates: 0, invalid: 0 });
  });
});

describe("computeConfidence — deterministic heuristics, hard caps per status", () => {
  const base = {
    syntaxValid: true,
    domainValid: true,
    mxValid: true,
    smtpChecked: true,
    smtpReachable: true,
    catchAll: false,
    disposable: false,
    roleAccount: false,
  };

  it("scores a clean VALID at 100", () => {
    expect(computeConfidence({ ...base, status: "VALID" })).toBe(100);
  });

  it("caps CATCH_ALL at 60", () => {
    // All the DNS/SMTP evidence in the world cannot push a catch-all above 60.
    const full = computeConfidence({ ...base, status: "CATCH_ALL", catchAll: true, smtpReachable: false });
    expect(full).toBeLessThanOrEqual(60);
    expect(full).toBeGreaterThanOrEqual(0);
  });

  it("caps RISKY at 55", () => {
    expect(computeConfidence({ ...base, status: "RISKY", roleAccount: true })).toBeLessThanOrEqual(55);
  });

  it("caps UNKNOWN below any VALID score", () => {
    expect(computeConfidence({ ...base, status: "UNKNOWN", smtpChecked: false, smtpReachable: false })).toBeLessThanOrEqual(45);
  });

  it("caps INVALID at 15 and floors at 0", () => {
    const invalid = computeConfidence({
      ...base,
      status: "INVALID",
      syntaxValid: false,
      domainValid: false,
      mxValid: false,
      smtpChecked: false,
      smtpReachable: false,
    });
    expect(invalid).toBeLessThanOrEqual(15);
    expect(computeConfidence({ ...base, status: "INVALID", syntaxValid: false, domainValid: false, mxValid: false, smtpChecked: false, smtpReachable: false, disposable: true, catchAll: true })).toBe(0);
    expect(invalid).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic", () => {
    const a = computeConfidence({ ...base, status: "RISKY", disposable: true });
    const b = computeConfidence({ ...base, status: "RISKY", disposable: true });
    expect(a).toBe(b);
  });
});

describe("campaign gate policy matrix", () => {
  const statuses: VerificationStatus[] = ["VALID", "INVALID", "CATCH_ALL", "RISKY", "UNKNOWN"];

  it("OFF and WARN never block anything", () => {
    for (const policy of ["OFF", "WARN"] as const) {
      for (const status of statuses) {
        expect(decideGate(policy, status).block).toBe(false);
        expect(decideGate(policy, status).reason).toBeNull();
      }
      expect(decideGate(policy, null).block).toBe(false);
    }
  });

  it("BLOCK_INVALID blocks only INVALID", () => {
    const blocked: VerificationStatus[] = ["INVALID"];
    for (const status of statuses) {
      const d = decideGate("BLOCK_INVALID", status);
      expect(d.block).toBe(blocked.includes(status));
      if (d.block) expect(d.reason).toBe(`${VERIFICATION_BLOCKED_PREFIX}: status=${status}`);
    }
  });

  it("BLOCK_INVALID_AND_RISKY blocks everything but a stored VALID", () => {
    const allowed: VerificationStatus[] = ["VALID"];
    for (const status of statuses) {
      const d = decideGate("BLOCK_INVALID_AND_RISKY", status);
      expect(d.block).toBe(!allowed.includes(status));
    }
  });

  it("never blocks an address with no stored result", () => {
    expect(decideGate("BLOCK_INVALID", null).block).toBe(false);
    expect(decideGate("BLOCK_INVALID_AND_RISKY", null).block).toBe(false);
    expect(decideGate("BLOCK_INVALID_AND_RISKY", null).status).toBeNull();
  });

  it("blockedStatuses reflects the same policy table", () => {
    expect(Array.from(blockedStatuses("OFF"))).toEqual([]);
    expect(Array.from(blockedStatuses("WARN"))).toEqual([]);
    expect(Array.from(blockedStatuses("BLOCK_INVALID"))).toEqual(["INVALID"]);
    expect(Array.from(blockedStatuses("BLOCK_INVALID_AND_RISKY")).sort()).toEqual(["CATCH_ALL", "INVALID", "RISKY", "UNKNOWN"]);
  });

  it("coercePolicy treats unknown/garbage as OFF", () => {
    expect(isVerificationPolicy("BLOCK_INVALID")).toBe(true);
    expect(isVerificationPolicy("NONSENSE")).toBe(false);
    expect(coercePolicy("NONSENSE")).toBe("OFF");
    expect(coercePolicy(null)).toBe("OFF");
    expect(coercePolicy(undefined)).toBe("OFF");
    expect(coercePolicy("WARN")).toBe("WARN");
  });

  it("policyDescription is explicit about each policy", () => {
    expect(policyDescription("OFF")).toContain("No verification check");
    expect(policyDescription("BLOCK_INVALID")).toContain("INVALID");
    expect(policyDescription("BLOCK_INVALID_AND_RISKY")).toContain("RISKY");
  });
});

describe("maskEmail", () => {
  it("keeps first local char and full domain", () => {
    expect(maskEmail("john.doe@example.com")).toBe("j***@example.com");
  });
  it("handles short locals and garbage", () => {
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
    expect(maskEmail("no-at-sign")).toBe("[invalid-address]");
  });
});

describe("isLoopbackServiceUrl (SSRF guard)", () => {
  it("accepts loopback forms", () => {
    expect(isLoopbackServiceUrl("http://127.0.0.1:8099")).toBe(true);
    expect(isLoopbackServiceUrl("http://localhost:8099")).toBe(true);
    expect(isLoopbackServiceUrl("http://127.0.0.2:9999")).toBe(true);
    expect(isLoopbackServiceUrl("http://[::1]:8099")).toBe(true);
    expect(isLoopbackServiceUrl("https://localhost:8443")).toBe(true);
  });
  it("rejects public hosts, other protocols, and garbage", () => {
    expect(isLoopbackServiceUrl("http://example.com:8099")).toBe(false);
    expect(isLoopbackServiceUrl("http://0.0.0.0:8099")).toBe(false);
    expect(isLoopbackServiceUrl("ftp://127.0.0.1:21")).toBe(false);
    expect(isLoopbackServiceUrl("not a url")).toBe(false);
    expect(isLoopbackServiceUrl("http://192.168.1.5:8099")).toBe(false);
  });
});

describe("worker backoff", () => {
  it("exponential with a cap", () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBe(60);
    expect(backoffSeconds(3)).toBe(120);
    // caps at 15 minutes
    expect(backoffSeconds(10)).toBe(900);
  });
});