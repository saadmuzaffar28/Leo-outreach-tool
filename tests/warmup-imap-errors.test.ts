/**
 * IMAP error classification — the security-relevant part.
 *
 * `classifyImapError` produces `userMessage`, and that string is not just for
 * logs: the IMAP test route returns it in an HTTP response, and the worker
 * persists it into `imapLastTestError`, which the settings page then displays.
 * So anything interpolated from the IMAP server's own response text becomes a
 * credential disclosure to anyone who can open that page.
 *
 * These tests exist because that was a real bug, caught in review rather than by
 * a failing test: the catch-all branch used to embed the raw error text.
 */

import { describe, it, expect } from "vitest";
import { classifyImapError, ImapError } from "@/lib/warmup/imap";

/** A server that echoes the login in its failure text, as Dovecot does. */
function serverSays(text: string) {
  return Object.assign(new Error(text), { responseCode: "AUTHENTICATIONFAILED" });
}

describe("classifyImapError never leaks the login back to the operator", () => {
  it("does not echo a username embedded in an unrecognised server error", () => {
    const raw = "Command failed: AUTHENTICATE PLAIN user=mailbox.owner@company.test (SERVERBUG)";
    const err = classifyImapError(serverSays(raw));

    expect(err.userMessage).not.toContain("mailbox.owner@company.test");
    expect(err.userMessage).not.toContain("user=");
    expect(err.userMessage).toBe(
      "IMAP reported an unrecognised error. See server logs for detail.",
    );
  });

  it("does not leak a password if a broken server echoes one", () => {
    const err = classifyImapError(serverSays("LOGIN failed for hunter2-was-here"));
    expect(err.userMessage).not.toContain("hunter2-was-here");
  });

  it("keeps the original error available on `cause` for server-side diagnosis", () => {
    const original = serverSays("AUTHENTICATE PLAIN user=leak@x.test");
    const err = classifyImapError(original);
    expect(err.cause).toBe(original);
    // ...but the cause is never the thing shown to anyone.
    expect(err.userMessage).not.toContain("leak@x.test");
  });

  it("does not echo server text on ANY branch, not just the catch-all", () => {
    const hostile = [
      "authentication ok for mailbox.owner@company.test",
      "getaddrinfo ENOTFOUND smtp.example.test (user=leak@x.test)",
      "socket hang up (user=leak@x.test)",
      "self signed certificate in chain to mail.corp.test (user=leak@x.test)",
      "totally novel failure containing leak@x.test and hunter2",
    ];
    for (const raw of hostile) {
      const err = classifyImapError(serverSays(raw));
      expect(err.userMessage, `leaked via: ${raw}`).not.toContain("leak@x.test");
      expect(err.userMessage, `leaked via: ${raw}`).not.toContain("hunter2");
      expect(err.userMessage, `leaked via: ${raw}`).not.toContain("@company.test");
    }
  });
});

describe("classifyImapError still classifies correctly", () => {
  it("authentication failures are permanent — retrying cannot help", () => {
    const err = classifyImapError(serverSays("AUTHENTICATIONFAILED Invalid credentials"));
    expect(err.code).toBe("IMAP_AUTH_FAILED");
    expect(err.permanent).toBe(true);
  });

  it("host-unreachable is retryable", () => {
    const err = classifyImapError(serverSays("getaddrinfo ENOTFOUND imap.example.test"));
    expect(err.code).toBe("IMAP_HOST_UNREACHABLE");
    expect(err.permanent).toBe(false);
  });

  it("connection resets are retryable", () => {
    const err = classifyImapError(serverSays("socket hang up"));
    expect(err.code).toBe("IMAP_CONNECTION");
    expect(err.permanent).toBe(false);
  });

  it("TLS problems are permanent — the config, not the moment, is wrong", () => {
    const err = classifyImapError(serverSays("self signed certificate in certificate chain"));
    expect(err.code).toBe("IMAP_TLS");
    expect(err.permanent).toBe(true);
  });

  it("an unrecognised error is retryable, so a blip does not pause a mailbox", () => {
    const err = classifyImapError(serverSays("something entirely new"));
    expect(err.code).toBe("IMAP_ERROR");
    expect(err.permanent).toBe(false);
  });

  it("passes an ImapError straight through, so re-classification is idempotent", () => {
    const original = new ImapError("IMAP_AUTH_FAILED", "nope", true);
    expect(classifyImapError(original)).toBe(original);
  });

  it("survives being handed something that is not an Error at all", () => {
    // The library can reject with a bare string or an object.
    for (const junk of ["just a string", { message: "an object" }, null, undefined, 42]) {
      const err = classifyImapError(junk);
      expect(err).toBeInstanceOf(ImapError);
      expect(typeof err.userMessage).toBe("string");
    }
  });
});