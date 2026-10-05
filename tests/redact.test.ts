/**
 * Redaction tests.
 *
 * These are the guard rails on the ONE place where provider-supplied text
 * becomes a durable log line. A failure here is a credential in a file that
 * gets shipped, grepped, and pasted into tickets, so the cases below are
 * written as "this exact string must not survive", not as "the output looks
 * tidy".
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { redactText, logSendFailure, logSmtpDiagnostic } from "@/lib/redact";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redactText", () => {
  it("masks an OAuth access token literal", () => {
    const out = redactText("token ya29.a0AfH6SMBx-secret-value rejected");
    expect(out).not.toContain("ya29.a0AfH6SMBx-secret-value");
    expect(out).toContain("[redacted-token]");
  });

  it("masks a Google refresh token literal", () => {
    expect(redactText("refresh 1//0gLongRefreshTokenValue")).not.toContain("0gLongRefreshTokenValue");
  });

  it("masks a key/value token", () => {
    const out = redactText('{"access_token": "abc123DEF456ghi"}');
    expect(out).not.toContain("abc123DEF456ghi");
  });

  it("masks a password in any of the shapes servers actually emit", () => {
    for (const raw of [
      "535 5.7.8 password=hunter2",
      "auth failed, password: hunter2",
      'Error: {"password":"hunter2"}',
    ]) {
      expect(redactText(raw)).not.toContain("hunter2");
    }
  });

  it("masks the credential half of a URL but keeps the host readable", () => {
    const out = redactText("failed to reach smtp://user:s3cr3t@mail.example.com:587");
    expect(out).not.toContain("s3cr3t");
    expect(out).toContain("mail.example.com");
  });

  it("masks an Authorization header", () => {
    expect(redactText("Authorization: Bearer ya29.SUPERSECRETVALUE")).not.toContain("SUPERSECRETVALUE");
  });

  it("masks email addresses so a log line cannot become a recipient list", () => {
    const out = redactText("gave up sending to jfillmore@cpcmds.com after 3 attempts");
    expect(out).not.toContain("jfillmore@cpcmds.com");
    expect(out).toContain("[email]");
  });

  it("masks an encrypted credential blob", () => {
    const blob = "a1b2c3d4e5f60718293a4b5c:dGhpcyBpcyBhbiBlbmNyaXB0ZWQ=:9f8e7d6c5b4a3928";
    expect(redactText(`stored ${blob} rejected`)).not.toContain("dGhpcyBpcyBhbiBlbmNyaXB0ZWQ");
  });

  it("truncates so an unrecognised leak shape is bounded", () => {
    const out = redactText("x".repeat(5000), 50);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves an ordinary, already-safe message intact", () => {
    const safe = "Temporary server error (503) — retried in 120s";
    expect(redactText(safe)).toBe(safe);
  });

  it("handles empty input", () => {
    expect(redactText("")).toBe("");
  });
});

describe("logSendFailure", () => {
  it("emits exactly one parseable JSON line with every diagnostic field", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entry = logSendFailure({
      campaignId: "cmulmq0xx012fid2kb1gjn9hf",
      recipientId: "cmulmrtmm01a2id2klrqd3tqh",
      provider: "google",
      accountId: "acct-1",
      attempt: 2,
      kind: "temporary",
      action: "schedule_retry",
      retryAfterSeconds: 144,
      detail: "Network error (ECONNRESET)",
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const emitted = JSON.parse(String(warn.mock.calls[0][0]));
    expect(emitted).toEqual(entry);
    expect(entry.event).toBe("campaign_send_failure");
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
  });

  it("redacts the detail field before it reaches the console", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSendFailure({
      campaignId: "c1",
      recipientId: "r1",
      provider: "smtp",
      accountId: "a1",
      attempt: 1,
      kind: "permanent",
      action: "fail_permanent",
      retryAfterSeconds: null,
      detail: "535 rejected: user=clinic@example.com password=hunter2",
    });

    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("clinic@example.com");
    expect(line).toContain("campaign_send_failure");
  });

  it("keeps identifiers intact — they are the point of the line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entry = logSendFailure({
      campaignId: "campaign-abc",
      recipientId: "recipient-xyz",
      provider: "microsoft",
      accountId: "account-123",
      attempt: 3,
      kind: "quota",
      action: "quota_backoff",
      retryAfterSeconds: 3600,
      detail: "Rate limited by the email provider (429)",
    });
    expect(entry.campaignId).toBe("campaign-abc");
    expect(entry.recipientId).toBe("recipient-xyz");
    expect(entry.accountId).toBe("account-123");
    expect(entry.attempt).toBe(3);
  });
});

describe("logSmtpDiagnostic", () => {
  function emit(over: Partial<Parameters<typeof logSmtpDiagnostic>[0]> = {}) {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entry = logSmtpDiagnostic({
      email: "andy@advancedmdmedicalbilling.com",
      host: "smtp.gmail.com",
      port: 587,
      security: "starttls",
      classifiedAs: "INVALID_CONFIG",
      detail: "550 5.7.1 Relay access denied",
      ...over,
    });
    warn.mockRestore();
    return entry;
  }

  it("carries every field the operator needs to identify the failure", () => {
    const entry = emit({ smtpErrorName: "Error", smtpErrorCode: "EENVELOPE", responseCode: 550, command: "RCPT" });
    expect(entry.event).toBe("smtp_diagnostic");
    expect(entry.email).toBe("andy@advancedmdmedicalbilling.com");
    expect(entry.host).toBe("smtp.gmail.com");
    expect(entry.port).toBe(587);
    expect(entry.security).toBe("starttls");
    expect(entry.classifiedAs).toBe("INVALID_CONFIG");
    expect(entry.smtpErrorName).toBe("Error");
    expect(entry.smtpErrorCode).toBe("EENVELOPE");
    expect(entry.responseCode).toBe(550);
    expect(entry.command).toBe("RCPT");
    expect(entry.detail).toContain("Relay access denied");
    expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);
  });

  it("emits exactly one machine-parseable JSON line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSmtpDiagnostic({
      email: "a@b.example",
      host: "h",
      port: 25,
      security: "none",
      classifiedAs: "HOST_UNREACHABLE",
      detail: "getaddrinfo ENOTFOUND",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({ event: "smtp_diagnostic" });
    warn.mockRestore();
  });

  it("redacts credentials and addresses out of the provider detail", () => {
    const entry = emit({
      detail: '535 5.7.8 authentication failed: user=leak@evil.example pass="hunter2"',
    });
    expect(entry.detail).not.toContain("hunter2");
    expect(entry.detail).not.toContain("leak@evil.example");
    expect(entry.detail).toContain("[redacted-credential]");
    // The account's OWN address is kept: it is the correlation key, not a
    // recipient, and it is the field that separates a failing mailbox from a
    // working one on identical configuration.
    expect(entry.email).toBe("andy@advancedmdmedicalbilling.com");
  });

  it("drops a command that is not a bare SMTP verb rather than logging free text", () => {
    // Provider-supplied, so it is whitelisted instead of escaped.
    expect(emit({ command: "MAIL FROM" }).command).toBeNull();
    expect(emit({ command: "EHLO" }).command).toBe("EHLO");
    expect(emit({ command: "EHLO\r\nINJECTED" }).command).toBeNull();
    expect(emit({ command: 42 as unknown as string }).command).toBeNull();
  });

  it("coerces a non-integer responseCode to null so it can never be a number elsewhere", () => {
    expect(emit({ responseCode: "550" as unknown as number }).responseCode).toBeNull();
    expect(emit({ responseCode: 1.5 }).responseCode).toBeNull();
    expect(emit({ responseCode: 535 }).responseCode).toBe(535);
  });

  it("has no field capable of holding a username, password, or ciphertext", () => {
    // Structural check: the interface itself must not offer a place for one.
    const entry = emit();
    const keys = Object.keys(entry);
    expect(keys).not.toContain("username");
    expect(keys).not.toContain("password");
    expect(keys).not.toContain("usernameEncrypted");
    expect(keys).not.toContain("passwordEncrypted");
    expect(keys.sort()).toEqual(
      ["classifiedAs", "command", "detail", "email", "event", "host", "port", "responseCode", "security", "smtpErrorCode", "smtpErrorName", "ts"].sort()
    );
  });

  it("caps the detail so one hostile reply cannot flood the log", () => {
    const entry = emit({ detail: "x".repeat(5000) });
    expect(entry.detail.length).toBeLessThanOrEqual(401);
    expect(entry.detail.endsWith("…")).toBe(true);
  });
});
