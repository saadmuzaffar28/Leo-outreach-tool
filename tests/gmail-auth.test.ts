import { describe, it, expect, vi, beforeEach } from "vitest";

const refreshMock = vi.fn();
const sendMock = vi.fn();
const sendCollector: { called: unknown[] } = { called: [] };

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
    async generateAuthUrl(opts: { state?: string }) {
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
  });

  it("builds an authorization URL (OAuth connect)", async () => {
    const url = await buildAuthUrl("state-1", "challenge-1");
    expect(url).toContain("accounts.google.com");
    expect(url).toContain("state-1");
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