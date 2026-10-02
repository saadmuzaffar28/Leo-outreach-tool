import { describe, it, expect } from "vitest";
import { decrypt, encrypt } from "@/lib/encryption";
import { decryptAccount, encryptTokens } from "@/lib/google";
import { buildMessageText, buildMessageHtml, stripHtmlToText, toBase64Url, encodeHeaderValue } from "@/lib/message";

describe("encryption", () => {
  it("round-trips values", () => {
    const p = "sensitive-token-123";
    const enc = encrypt(p);
    expect(enc).not.toContain(p);
    expect(decrypt(enc)).toBe(p);
  });

  it("produces unique ciphertexts", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("rejects tampered payloads", () => {
    const enc = encrypt("hello");
    const tampered = enc.slice(0, -2) + "ff";
    expect(() => decrypt(tampered)).toThrow();
  });

  it("encryptTokens/decryptAccount round-trip", () => {
    const stored = encryptTokens({
      access_token: "access",
      refresh_token: "refresh",
      expiry_date: Date.now() + 100000,
    });
    const account = decryptAccount({
      id: "a1",
      userId: "u1",
      googleEmail: "me@example.com",
      accessTokenEncrypted: stored.accessTokenEncrypted,
      refreshTokenEncrypted: stored.refreshTokenEncrypted,
      expiresAt: stored.expiresAt,
      signature: null,
    });
    expect(account.accessToken).toBe("access");
    expect(account.refreshToken).toBe("refresh");
    expect(account.expiresAt).toBeInstanceOf(Date);
  });
});

describe("message builder", () => {
  it("builds a well-formed message with unsubscribe headers", () => {
    const msg = buildMessageText({
      fromName: "Star Billing",
      fromEmail: "star@example.com",
      to: "lead@example.com",
      subject: "Revenue Cycle Review",
      body: "Hi Alex,\n\nReady?",
      unsubscribeUrl: "https://app.example.com/unsubscribe?x=1",
    });
    expect(msg).toContain("From: Star Billing <star@example.com>");
    expect(msg).toContain("To: <lead@example.com>");
    expect(msg).toContain("Subject: Revenue Cycle Review");
    expect(msg).toContain("List-Unsubscribe: <https://app.example.com/unsubscribe?x=1>");
    expect(msg).not.toContain("Unsubscribe: https://app.example.com/unsubscribe?x=1");
    expect(msg).not.toContain("You are receiving this outreach email.");
    expect(msg).toContain("Hi Alex,\n\nReady?");
    expect(msg.match(/\r\n/g)?.length).toBeGreaterThan(0);
  });

  it("encodes non-ASCII headers", () => {
    expect(encodeHeaderValue("Café")).toBe("=?UTF-8?B?Q2Fmw6k=?=");
    expect(encodeHeaderValue("Plain")).toBe("Plain");
  });

  it("base64url encodes and decodes", () => {
    const raw = Buffer.from("Hello\nWorld");
    const encoded = toBase64Url("Hello\nWorld");
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe("Hello\nWorld");
    expect(encoded).not.toContain("+");
  });

  it("appends the Gmail signature only when present", () => {
    const base = {
      fromName: "Leo Collins",
      fromEmail: "leo@example.com",
      to: "lead@example.com",
      subject: "S",
      body: "Hi,\n\nEnd.",
      unsubscribeUrl: null,
    };
    const plain = buildMessageText(base);
    expect(plain).not.toContain("Signature");
    expect(plain).toContain("End.");

    const sig = '<div dir="ltr">Leo Collins<br>Star Billing<br><a href="https://example.com">site</a></div>';
    const withSig = buildMessageText({ ...base, signatureHtml: sig });
    expect(withSig).toContain("End.");
    expect(withSig).toContain("\n\nLeo Collins");
    expect(withSig).toContain("Star Billing");

    const html = buildMessageHtml({ ...base, signatureHtml: sig });
    expect(html).toContain("multipart/alternative");
    expect(html).toContain('Content-Type: text/html; charset=UTF-8');
    expect(html).toContain('<div dir="ltr">Leo Collins');
    const decoded = Buffer.from(toBase64Url(html), "base64url").toString("utf8");
    expect(decoded).toContain('<a href="https://example.com">site</a>');
  });

  it("strips HTML down to readable text", () => {
    expect(stripHtmlToText('<p>Hi</p><br>Leo &amp; Co<br><a>x</a>')).toContain("Leo & Co");
  });
});