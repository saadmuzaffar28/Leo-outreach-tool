import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildAuthorizeUrl,
  decryptMicrosoftAccount,
  encryptMicrosoftTokens,
  microsoftRedirectUri,
  MicrosoftGraphError,
} from "@/lib/microsoft";
import { classifySendError, decideSendError } from "@/lib/send-queue";
import { decrypt } from "@/lib/encryption";

describe("Microsoft OAuth helpers", () => {
  it("builds an authorization URL against the v2.0 endpoint", () => {
    const url = new URL(buildAuthorizeUrl("state-123"));
    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toMatch(/\/oauth2\/v2\.0\/authorize$/);
    expect(url.searchParams.get("client_id")).toBe(process.env.MICROSOFT_CLIENT_ID ?? "");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("redirect_uri")).toBe(microsoftRedirectUri());
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("scope")).toContain("Mail.Send");
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });

  it("encrypts tokens and decrypts the account back", () => {
    const encrypted = encryptMicrosoftTokens({
      accessToken: "acc",
      refreshToken: "ref",
      expiresAt: new Date("2026-12-31T00:00:00Z"),
    });
    expect(decrypt(encrypted.accessTokenEncrypted)).toBe("acc");
    expect(decrypt(encrypted.refreshTokenEncrypted!)).toBe("ref");

    const account = decryptMicrosoftAccount({
      id: "ms-1",
      userId: "user-1",
      microsoftEmail: "leo@outlook.com",
      displayName: "Leo",
      connectMode: "normal",
      sendFromEmail: null,
      accessTokenEncrypted: encrypted.accessTokenEncrypted,
      refreshTokenEncrypted: encrypted.refreshTokenEncrypted,
      expiresAt: encrypted.expiresAt,
    });
    expect(account.microsoftEmail).toBe("leo@outlook.com");
    expect(account.accessToken).toBe("acc");
    expect(account.refreshToken).toBe("ref");
    expect(account.expiresAt?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });
});

describe("Microsoft Graph error classification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("classifies 429 as quota", () => {
    const err = new MicrosoftGraphError(429, "TooManyRequests: throttled", undefined, 30);
    const info = classifySendError(err);
    expect(info.kind).toBe("quota");
    expect(decideSendError(err, 1, { maxRetryAttempts: 5, baseRetryDelaySeconds: 60, maxRetryDelaySeconds: 3600 }).action).toBe("quota_backoff");
  });

  it("classifies a revoked grant as auth (non-retryable)", () => {
    const err = new MicrosoftGraphError(400, "invalid_grant: token expired");
    const info = classifySendError(err);
    expect(info.kind).toBe("auth");
    expect(info.retryable).toBe(false);
    expect(decideSendError(err, 0, { maxRetryAttempts: 5, baseRetryDelaySeconds: 60, maxRetryDelaySeconds: 3600 }).action).toBe("auth_required");
  });

  it("classifies 401 as temporary (refresh and retry)", () => {
    const info = classifySendError(new MicrosoftGraphError(401, "InvalidAuthenticationToken"));
    expect(info.kind).toBe("temporary");
    expect(decideSendError(new MicrosoftGraphError(401, "InvalidAuthenticationToken"), 0, { maxRetryAttempts: 5, baseRetryDelaySeconds: 60, maxRetryDelaySeconds: 3600 }).action).toBe("schedule_retry");
  });

  it("classifies 403 permission errors as permanent", () => {
    const info = classifySendError(new MicrosoftGraphError(403, "ErrorAccessDenied: insufficient privileges"));
    expect(info.kind).toBe("permanent");
  });

  it("parses the mailbox from the /me response", async () => {
    const { fetchGraphProfile } = await import("@/lib/microsoft");
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: "oid", displayName: "Leo", mail: "LEO@OUTLOOK.COM" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const profile = await fetchGraphProfile("tok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(profile.email).toBe("leo@outlook.com");
    expect(profile.displayName).toBe("Leo");
  });

  it("falls back to userPrincipalName when mail is missing", async () => {
    const { fetchGraphProfile } = await import("@/lib/microsoft");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ id: "oid", displayName: null, userPrincipalName: "leo@contoso.com" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const profile = await fetchGraphProfile("tok");
    expect(profile.email).toBe("leo@contoso.com");
  });
});