import { describe, it, expect } from "vitest";

import {
  mergeStoredTokens,
  deriveAccountStatus,
  normalizeAccountStatus,
  GMAIL_STATUS_LABELS,
  GMAIL_ACCOUNT_STATUSES,
  encryptTokens,
  OAUTH_SCOPES,
  GMAIL_SEND_SCOPE,
  GMAIL_SETTINGS_BASIC_SCOPE,
} from "@/lib/google";
import { decrypt } from "@/lib/encryption";

/**
 * These guard the two failure modes that would silently break a Gmail account
 * that is currently working:
 *   - a re-authorization or token refresh that erases the stored refresh token
 *   - a dead grant going unnoticed, so the operator never sees "Reconnect"
 */
describe("mergeStoredTokens", () => {
  const existing = { refreshTokenEncrypted: "existing-refresh-blob" };

  it("keeps the stored refresh token when Google returns none", () => {
    // Re-authorizing an already-approved app, and every token refresh, comes
    // back without a refresh_token. Writing that straight to the row would
    // null out a working grant.
    const fresh = { accessTokenEncrypted: "fresh-access", refreshTokenEncrypted: null, expiresAt: new Date(5000) };
    const merged = mergeStoredTokens(fresh, existing);
    expect(merged.refreshTokenEncrypted).toBe("existing-refresh-blob");
  });

  it("keeps the stored refresh token even when the fresh blob is empty-ish", () => {
    const fresh = { accessTokenEncrypted: "a", refreshTokenEncrypted: null, expiresAt: null };
    expect(mergeStoredTokens(fresh, existing).refreshTokenEncrypted).toBe("existing-refresh-blob");
  });

  it("replaces the refresh token only when Google actually issues a new one", () => {
    const fresh = { accessTokenEncrypted: "a", refreshTokenEncrypted: "brand-new-blob", expiresAt: new Date(1) };
    expect(mergeStoredTokens(fresh, existing).refreshTokenEncrypted).toBe("brand-new-blob");
  });

  it("always takes the fresh access token and expiry", () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    const merged = mergeStoredTokens(
      { accessTokenEncrypted: "fresh-access", refreshTokenEncrypted: null, expiresAt },
      existing,
    );
    expect(merged.accessTokenEncrypted).toBe("fresh-access");
    expect(merged.expiresAt).toEqual(expiresAt);
  });

  it("stays null when there was no prior refresh token and none was issued", () => {
    const merged = mergeStoredTokens(
      { accessTokenEncrypted: "a", refreshTokenEncrypted: null, expiresAt: null },
      { refreshTokenEncrypted: null },
    );
    expect(merged.refreshTokenEncrypted).toBeNull();
  });

  it("round-trips a real encrypted payload without losing the refresh token", () => {
    const fresh = encryptTokens({ access_token: "new-access", expiry_date: 4242 });
    expect(fresh.refreshTokenEncrypted).toBeNull(); // Google sent none
    const merged = mergeStoredTokens(fresh, existing);
    expect(merged.refreshTokenEncrypted).toBe("existing-refresh-blob");
    expect(decrypt(merged.accessTokenEncrypted)).toBe("new-access");
  });
});

describe("normalizeAccountStatus", () => {
  it("passes through every known status", () => {
    for (const s of GMAIL_ACCOUNT_STATUSES) {
      expect(normalizeAccountStatus(s)).toBe(s);
    }
  });

  it("treats unknown, null and undefined values as healthy", () => {
    // A pre-migration row has no status at all and must not look broken.
    expect(normalizeAccountStatus(null)).toBe("connected");
    expect(normalizeAccountStatus(undefined)).toBe("connected");
    expect(normalizeAccountStatus("something-else")).toBe("connected");
  });

  it("has a display label for every status", () => {
    for (const s of GMAIL_ACCOUNT_STATUSES) {
      expect(GMAIL_STATUS_LABELS[s]).toBeTruthy();
    }
  });
});

describe("deriveAccountStatus", () => {
  const now = 1_700_000_000_000;

  it("is connected when a refresh token is stored", () => {
    expect(
      deriveAccountStatus({ storedStatus: null, hasRefreshToken: true, expiresAt: new Date(now - 10_000), now }),
    ).toBe("connected");
  });

  it("keeps reauth_required sticky until a fresh authorization clears it", () => {
    // The worker sets this when Google rejects the grant; token state cannot
    // talk it back into health.
    expect(
      deriveAccountStatus({ storedStatus: "reauth_required", hasRefreshToken: true, expiresAt: null, now }),
    ).toBe("reauth_required");
  });

  it("reports token_expired when there is no offline grant and the access token died", () => {
    expect(
      deriveAccountStatus({ storedStatus: "connected", hasRefreshToken: false, expiresAt: new Date(now - 1), now }),
    ).toBe("token_expired");
  });

  it("reports token_expired when there is no offline grant and no expiry at all", () => {
    expect(deriveAccountStatus({ storedStatus: "connected", hasRefreshToken: false, expiresAt: null, now })).toBe(
      "token_expired",
    );
  });

  it("stays connected without a refresh token while the access token is still valid", () => {
    expect(
      deriveAccountStatus({ storedStatus: "connected", hasRefreshToken: false, expiresAt: new Date(now + 60_000), now }),
    ).toBe("connected");
  });

  it("recovers on its own once an offline grant exists again", () => {
    expect(
      deriveAccountStatus({ storedStatus: "token_expired", hasRefreshToken: true, expiresAt: null, now }),
    ).toBe("connected");
  });
});

describe("scopes stay unchanged", () => {
  it("requests only the two Gmail scopes plus identity", () => {
    expect(OAUTH_SCOPES).toContain(GMAIL_SEND_SCOPE);
    expect(OAUTH_SCOPES).toContain(GMAIL_SETTINGS_BASIC_SCOPE);
    expect(OAUTH_SCOPES).toContain("openid");
    expect(OAUTH_SCOPES).toContain("email");
    // No broader Gmail scope was introduced for multi-account support.
    const gmailScopes = OAUTH_SCOPES.filter((s) => s.includes("gmail"));
    expect(gmailScopes.sort()).toEqual([GMAIL_SEND_SCOPE, GMAIL_SETTINGS_BASIC_SCOPE].sort());
  });
});
