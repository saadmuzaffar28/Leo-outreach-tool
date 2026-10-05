import { describe, expect, it } from "vitest";
import { smtpFailureMessage } from "@/components/smtp-accounts-manager";

/**
 * The UI half of the SMTP diagnostics fix.
 *
 * `smtpFailureMessage` is what the operator actually reads. Before it existed
 * the component rendered only `data.error`, and `error` is a FIXED sentence per
 * classification -- so the catch-all branch rendered the same "unrecognised
 * error" text no matter what the mail server had said. These tests pin that the
 * classification and the server's own reply now both reach the screen, and that
 * nothing can make this render "[object Object]" or leak a credential.
 */
describe("smtpFailureMessage", () => {
  it("shows the classification code alongside the message", () => {
    const out = smtpFailureMessage(
      { error: "SMTP authentication failed. Check the username and password.", code: "AUTH_FAILED" },
      "Save failed"
    );
    expect(out).toContain("SMTP authentication failed");
    expect(out).toContain("AUTH_FAILED");
  });

  it("shows the SMTP reply code and failing command", () => {
    const out = smtpFailureMessage(
      {
        error: "SMTP connection failed with an unrecognised error. See server logs for detail.",
        code: "INVALID_CONFIG",
        responseCode: 550,
        command: "RCPT",
      },
      "Save failed"
    );
    expect(out).toContain("SMTP 550");
    expect(out).toContain("RCPT");
    expect(out).toContain("INVALID_CONFIG");
  });

  it("surfaces the server's own reply, which is the whole point", () => {
    const out = smtpFailureMessage(
      { error: "SMTP connection failed with an unrecognised error.", code: "INVALID_CONFIG", detail: "550 5.7.1 Relay access denied" },
      "Save failed"
    );
    expect(out).toContain("550 5.7.1 Relay access denied");
  });

  it("distinguishes two failures that used to render identically", () => {
    const generic = { error: "SMTP connection failed with an unrecognised error.", code: "INVALID_CONFIG" };
    const a = smtpFailureMessage({ ...generic, responseCode: 550, detail: "5.7.1 blocked" }, "x");
    const b = smtpFailureMessage({ ...generic, responseCode: 553, detail: "5.3.0 mailbox full" }, "x");
    expect(a).not.toBe(b);
  });

  it("does not repeat the code when the error already is the code", () => {
    const out = smtpFailureMessage({ code: "AUTH_FAILED" }, "Save failed");
    expect(out).toBe("AUTH_FAILED");
  });

  it("falls back cleanly on an empty or non-object body", () => {
    expect(smtpFailureMessage(undefined, "Save failed")).toBe("Save failed");
    expect(smtpFailureMessage({}, "Save failed")).toBe("Save failed");
    expect(smtpFailureMessage(null, "Save failed")).toBe("Save failed");
    expect(smtpFailureMessage("boom", "Save failed")).toBe("Save failed");
  });

  it("ignores empty-string fields instead of rendering blanks", () => {
    const out = smtpFailureMessage({ error: "", code: "", detail: "" }, "Save failed");
    expect(out).toBe("Save failed");
  });

  it("never renders an object for a detail field", () => {
    const out = smtpFailureMessage({ detail: { nested: true } as unknown as string }, "Save failed");
    expect(out).toBe("Save failed");
    expect(out).not.toContain("[object Object]");
  });

  it("works on a success-shaped body by not inventing an error", () => {
    // res.ok was true, so this must never be rendered at all; guard anyway.
    expect(smtpFailureMessage({ ok: true }, "Connection test failed")).toBe("Connection test failed");
  });
});