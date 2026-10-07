/**
 * Unit tests for the AfterShip adapter's status-mapping matrix (Phase 4/5).
 *
 * These are pure — no DB, no network. They pin the ONE place in the codebase
 * that knows AfterShip's payload shapes: every branch of classifyPayload.
 *
 * The mapping rules under test (SMTP-safety first):
 *   - a temporary/ambiguous response is NEVER classified INVALID;
 *   - only clear evidence (syntax, dead domain, no MX, definitive 5xx
 *     rejection) earns INVALID;
 *   - acceptance ⇒ VALID, catch-all ⇒ CATCH_ALL, warnings ⇒ RISKY,
 *     inconclusive ⇒ UNKNOWN.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeAfterShipResult,
  syntaxFailureResult,
  engineFailureResult,
  type AfterShipPayload,
  type AfterShipErrorKind,
} from "@/lib/verification/aftership-adapter";

/** A payload that would map to a clean VALID — then tests override facts. */
function payload(over: Partial<AfterShipPayload> = {}): AfterShipPayload {
  const { smtp: smtpOver, ...rest } = over;
  return {
    email: "user@example.com",
    reachable: "yes",
    syntax: { username: "user", domain: "example.com", valid: true },
    has_mx_records: true,
    disposable: false,
    role_account: false,
    free: false,
    suggestion: "",
    smtp: smtpOver === undefined
      ? { host_exists: true, full_inbox: false, catch_all: false, deliverable: true, disabled: false }
      : smtpOver,
    error: null,
    ...rest,
  };
}

function smtp(over: Partial<AfterShipPayload["smtp"]> = {}): AfterShipPayload["smtp"] {
  return { host_exists: true, full_inbox: false, catch_all: false, deliverable: true, disabled: false, ...over };
}

function err(kind: AfterShipErrorKind): AfterShipPayload["error"] {
  return { message: `msg-${kind}`, details: `detail-${kind}`, kind };
}

const result = (email: string, over: Partial<AfterShipPayload> = {}) =>
  normalizeAfterShipResult(email, payload(over));

describe("syntax", () => {
  it("invalid syntax is INVALID without touching the network stack", () => {
    const r = result("user@example.com", {
      syntax: { username: "", domain: "", valid: false },
      has_mx_records: false,
      smtp: null,
    });
    expect(r.status).toBe("INVALID");
    expect(r.errorCode).toBe("syntax_invalid");
    expect(r.syntaxValid).toBe(false);
    expect(r.domainValid).toBe(false);
    expect(r.mxValid).toBe(false);
    expect(r.confidence).toBeLessThanOrEqual(15);
  });
});

describe("disposable domains", () => {
  it("a disposable domain is RISKY even when the SMTP probe was accepted", () => {
    const r = result("user@mailinator.com", { disposable: true });
    expect(r.status).toBe("RISKY");
    expect(r.errorCode).toBe("disposable_domain");
    expect(r.disposable).toBe(true);
  });
});

describe("engine error kinds", () => {
  const cases: Array<{ kind: AfterShipErrorKind; status: string; code: string }> = [
    { kind: "no_such_host", status: "INVALID", code: "domain_not_found" },
    { kind: "no_mx", status: "INVALID", code: "no_mx_record" },
    { kind: "mailbox_rejected", status: "INVALID", code: "smtp_mailbox_rejected" },
    { kind: "timeout", status: "UNKNOWN", code: "smtp_timeout" },
    { kind: "connection_refused", status: "UNKNOWN", code: "smtp_connection_refused" },
    { kind: "blocked", status: "UNKNOWN", code: "smtp_blocked" },
    { kind: "temp_failure", status: "UNKNOWN", code: "smtp_temporary_failure" },
    { kind: "service_unavailable", status: "UNKNOWN", code: "smtp_service_unavailable" },
    { kind: "other", status: "UNKNOWN", code: "smtp_error" },
  ];

  it.each(cases)("kind=$kind ⇒ $status / $code", ({ kind, status, code }) => {
    const r = result("user@example.com", { error: err(kind) });
    expect(r.status).toBe(status);
    expect(r.errorCode).toBe(code);
    expect(r.errorMessage).toContain("detail-" + kind);
  });

  it("a definitive DNS failure wins over a delivered SMTP block (error is authoritative)", () => {
    const r = result("user@example.com", { error: err("no_such_host"), smtp: smtp({ deliverable: true }) });
    expect(r.status).toBe("INVALID");
    expect(r.errorCode).toBe("domain_not_found");
  });

  it("never classifies a temporary SMTP response as INVALID", () => {
    for (const kind of ["timeout", "connection_refused", "blocked", "temp_failure", "service_unavailable", "other"] as const) {
      expect(result("user@example.com", { error: err(kind) }).status).toBe("UNKNOWN");
    }
  });
});

describe("DNS-only facts (no SMTP block)", () => {
  it("missing MX ⇒ INVALID, with the suggestion surfaced in the message", () => {
    const r = result("user@gmaiil.com", {
      has_mx_records: false,
      smtp: null,
      suggestion: "gmail.com",
    });
    expect(r.status).toBe("INVALID");
    expect(r.errorCode).toBe("no_mx_record");
    expect(r.typoSuggestion).toBe("gmail.com");
    expect(r.errorMessage).toContain("gmail.com");
  });

  it("SMTP not performed at all ⇒ UNKNOWN, never INVALID", () => {
    const r = result("user@example.com", { smtp: null, reachable: "unknown" });
    expect(r.status).toBe("UNKNOWN");
    expect(r.errorCode).toBe("smtp_not_checked");
  });
});

describe("SMTP facts", () => {
  it("accepted RCPT ⇒ VALID at full confidence", () => {
    const r = result("user@example.com");
    expect(r.status).toBe("VALID");
    expect(r.errorCode).toBeNull();
    expect(r.errorMessage).toBeNull();
    expect(r.confidence).toBe(100);
    expect(r.smtpReachable).toBe(true);
    expect(r.catchAll).toBe(false);
  });

  it("role account upgrades a VALID verdict to RISKY", () => {
    const r = result("info@example.com", { role_account: true });
    expect(r.status).toBe("RISKY");
    expect(r.errorCode).toBe("role_account");
    expect(r.roleAccount).toBe(true);
    const plain = result("info@example.com", { role_account: false });
    expect(plain.status).toBe("VALID");
  });

  it("full inbox ⇒ RISKY", () => {
    const r = result("user@example.com", { smtp: smtp({ deliverable: false, full_inbox: true }) });
    expect(r.status).toBe("RISKY");
    expect(r.errorCode).toBe("mailbox_full");
  });

  it("disabled/policy-blocked mailbox ⇒ RISKY", () => {
    const r = result("user@example.com", { smtp: smtp({ deliverable: false, disabled: true }) });
    expect(r.status).toBe("RISKY");
    expect(r.errorCode).toBe("mailbox_disabled");
  });

  it("catch-all server ⇒ CATCH_ALL, capped confidence, never VALID", () => {
    const r = result("user@example.com", { smtp: smtp({ deliverable: false, catch_all: true }) });
    expect(r.status).toBe("CATCH_ALL");
    expect(r.errorCode).toBe("catch_all_domain");
    expect(r.catchAll).toBe(true);
    expect(r.confidence).toBeLessThanOrEqual(60);
  });

  it("definitive 'no' from the server (not catch-all) ⇒ INVALID", () => {
    const r = result("user@example.com", {
      reachable: "no",
      smtp: smtp({ deliverable: false, catch_all: false }),
    });
    expect(r.status).toBe("INVALID");
    expect(r.errorCode).toBe("smtp_mailbox_rejected");
  });

  it("inconclusive server response ⇒ UNKNOWN (anti-enumeration safety)", () => {
    const r = result("user@example.com", {
      reachable: "unknown",
      smtp: smtp({ deliverable: false, catch_all: false, full_inbox: false, disabled: false }),
    });
    expect(r.status).toBe("UNKNOWN");
    expect(r.errorCode).toBe("smtp_inconclusive");
  });
});

describe("syntaxFailureResult", () => {
  it("is INVALID / syntax_invalid with confidence at the INVALID cap", () => {
    const r = syntaxFailureResult("  NOT AN EMAIL  ");
    expect(r.status).toBe("INVALID");
    expect(r.errorCode).toBe("syntax_invalid");
    expect(r.normalizedEmail).toBe("not an email");
    expect(r.confidence).toBeLessThanOrEqual(15);
    expect(r.syntaxValid).toBe(false);
  });
});

describe("engineFailureResult", () => {
  it("is always UNKNOWN and carries the error code", () => {
    const r = engineFailureResult("user@example.com", "engine_timeout", "did not answer");
    expect(r.status).toBe("UNKNOWN");
    expect(r.errorCode).toBe("engine_timeout");
    expect(r.errorMessage).toContain("did not answer");
  });

  it("plausible addresses keep syntaxValid=true; garbage does not", () => {
    expect(engineFailureResult("a@b.co", "service_unavailable", "down").syntaxValid).toBe(true);
    expect(engineFailureResult("!!", "service_unavailable", "down").syntaxValid).toBe(false);
  });

  it("redacts embedded emails from provider prose", () => {
    const r = engineFailureResult("user@example.com", "engine_error", "boom user@example.com");
    expect(r.errorMessage).not.toContain("user@example.com");
    expect(r.errorMessage).toContain("[email]");
  });

  it("bounds stored error prose to the detail cap (plus the truncation ellipsis)", () => {
    const r = engineFailureResult("a@b.co", "engine_error", "x".repeat(2000));
    const msg = r.errorMessage ?? "";
    expect(msg.length).toBeLessThanOrEqual(301);
    expect(msg.startsWith("x".repeat(300))).toBe(true);
  });
});

describe("normalization passthroughs", () => {
  it("keeps the submitted email, normalized key, free-provider flag and version", () => {
    const r = result(" User@FreeMail.com ", { free: true });
    expect(r.email).toBe(" User@FreeMail.com ");
    expect(r.normalizedEmail).toBe("user@freemail.com");
    expect(r.freeProvider).toBe(true);
    expect(r.provider).toBe("aftership");
    expect(r.verificationVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});