import { describe, it, expect, vi, beforeEach } from "vitest";

const refreshMock = vi.fn();
const sendMock = vi.fn();
const sendCollector: { called: unknown[] } = { called: [] };
const authUrlCollector: { opts: Record<string, unknown>[] } = { opts: [] };

vi.mock("googleapis", () => {
  class OAuth2Mock {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
    }
    isTokenExpiring() {
      return true; // always force a refresh in tests
    }
    async refreshAccessToken() {
      refreshMock();
      return { credentials: { access_token: "fresh-access", refresh_token: "fresh-refresh", expiry_date: 9999999999000 } };
    }
    async generateAuthUrl(opts: Record<string, unknown>) {
      authUrlCollector.opts.push(opts);
      return `https://accounts.google.com/o/oauth2/v2/auth?scope=test&state=${opts.state ?? ""}`;
    }
    async getToken() {
      return { tokens: { access_token: "code-access", refresh_token: "code-refresh", expiry_date: 123 } };
    }
  }
  return {
    google: {
      auth: { OAuth2: OAuth2Mock },
      gmail: vi.fn(() => ({
        users: {
          messages: {
            send: vi.fn(async (req) => {
              sendCollector.called.push(req);
              return { data: { id: "gmail-message-1" } };
            }),
          },
          getProfile: vi.fn(async () => ({ data: { emailAddress: "me@example.com" } })),
        },
      })),
    },
  };
});

import { getAuthorizedOAuthClient, buildAuthUrl } from "@/lib/google";
import { decrypt } from "@/lib/encryption";

describe("Gmail authentication", () => {
  beforeEach(() => {
    refreshMock.mockClear();
    sendCollector.called = [];
    authUrlCollector.opts = [];
  });

  it("builds an authorization URL (OAuth connect)", async () => {
    const url = await buildAuthUrl("state-1", "challenge-1");
    expect(url).toContain("accounts.google.com");
    expect(url).toContain("state-1");
  });

  it("forces the Google account chooser so a second Gmail can be added", async () => {
    await buildAuthUrl("state-2", "challenge-2");
    const opts = authUrlCollector.opts[0];
    // Without "select_account", Google silently re-authorizes whichever
    // account is already signed in instead of letting the user pick another.
    const prompt = String(opts.prompt ?? "");
    expect(prompt.split(/\s+/)).toContain("select_account");
    // "consent" must stay or Google stops issuing the offline refresh token.
    expect(prompt.split(/\s+/)).toContain("consent");
  });

  it("keeps the existing scopes and offline access when adding an account", async () => {
    await buildAuthUrl("state-3", "challenge-3");
    const opts = authUrlCollector.opts[0];
    expect(opts.access_type).toBe("offline");
    expect(opts.scope).toContain("https://www.googleapis.com/auth/gmail.send");
    expect(opts.scope).toContain("https://www.googleapis.com/auth/gmail.settings.basic");
    // No scope beyond the two the app already used.
    expect((opts.scope as string[]).length).toBe(4); // send, settings.basic, openid, email
  });

  it("refreshes near-expired access tokens and encrypts the new credentials", async () => {
    const account = {
      id: "acc-1",
      userId: "user-1",
      googleEmail: "me@example.com",
      accessToken: "stale-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() - 60_000), // expired
      signature: null,
    };

    const { client, refreshedTokens } = await getAuthorizedOAuthClient(account);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(client).toBeDefined();
    expect(refreshedTokens).not.toBeNull();
    const plain = decrypt(refreshedTokens!.accessTokenEncrypted);
    expect(plain).toBe("fresh-access");
  });
});