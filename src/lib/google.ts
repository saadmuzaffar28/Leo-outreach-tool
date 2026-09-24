import { google } from "googleapis";
import { CodeChallengeMethod } from "google-auth-library";
import { createHash, randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { decrypt, encrypt } from "@/lib/encryption";
import type { MailMessage } from "@/lib/message";
import { buildRawMessage } from "@/lib/message";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_SETTINGS_BASIC_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic";
export const OAUTH_SCOPES = [GMAIL_SEND_SCOPE, GMAIL_SETTINGS_BASIC_SCOPE, "openid", "email"];

export type GmailOAuthClient = InstanceType<typeof google.auth.OAuth2>;

export interface DecryptedAccount {
  id: string;
  userId: string;
  googleEmail: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  signature: string | null;
}

export interface StoredTokens {
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  expiresAt: Date | null;
}

/** Decrypted Google OAuth tokens — only ever constructed server-side. */
export function decryptAccount(account: {
  id: string;
  userId: string;
  googleEmail: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  expiresAt: Date | null;
  signature: string | null;
}): DecryptedAccount {
  return {
    id: account.id,
    userId: account.userId,
    googleEmail: account.googleEmail,
    accessToken: decrypt(account.accessTokenEncrypted),
    refreshToken: account.refreshTokenEncrypted ? decrypt(account.refreshTokenEncrypted) : null,
    expiresAt: account.expiresAt,
    signature: account.signature,
  };
}

export function encryptTokens(tokens: {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
}): StoredTokens {
  return {
    accessTokenEncrypted: encrypt(tokens.access_token ?? ""),
    refreshTokenEncrypted: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
  };
}

export function getOAuthClient(accessToken?: string, refreshToken?: string): GmailOAuthClient {
  return new google.auth.OAuth2({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
    credentials: {
      access_token: accessToken ?? undefined,
      refresh_token: refreshToken ?? undefined,
    },
  });
}

export function generateCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthUrl(state: string, codeChallenge: string): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: OAUTH_SCOPES,
    state,
    include_granted_scopes: true,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });
}

export async function exchangeCode(code: string, codeVerifier: string) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken({ code, codeVerifier });
  return tokens;
}

/**
 * Returns an OAuth2 client ready to call the Gmail API.
 * Refreshes + returns the new token payload when the stored access token is near expiry.
 */
export async function getAuthorizedOAuthClient(
  account: DecryptedAccount,
): Promise<{ client: GmailOAuthClient; refreshedTokens: StoredTokens | null }> {
  const client = getOAuthClient(account.accessToken, account.refreshToken ?? undefined);
  const expiresAt = account.expiresAt ? new Date(account.expiresAt).getTime() : 0;
  const nearExpiry = Date.now() > expiresAt - 5 * 60 * 1000;
  if (nearExpiry && account.refreshToken) {
    const { credentials } = await client.refreshAccessToken();
    return { client, refreshedTokens: encryptTokens(credentials) };
  }
  return { client, refreshedTokens: null };
}

export interface SendResult {
  messageId: string;
}

/** Sends a single message via the official Gmail API as the connected user. */
export async function sendMessage(
  oauth: GmailOAuthClient,
  msg: MailMessage,
): Promise<SendResult> {
  const gmail = google.gmail({ version: "v1", auth: oauth });
  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: buildRawMessage(msg) },
  });
  return { messageId: response.data.id ?? "" };
}

export async function fetchGmailProfile(oauth: GmailOAuthClient): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth: oauth });
  const { data } = await gmail.users.getProfile({ userId: "me" });
  return data.emailAddress ?? "";
}

/** Returns the account's default send-as signature (HTML) from Gmail settings. */
export async function fetchGmailSignature(oauth: GmailOAuthClient): Promise<string | null> {
  const gmail = google.gmail({ version: "v1", auth: oauth });
  const { data } = await gmail.users.settings.sendAs.list({ userId: "me" });
  const defaultSendAs = (data.sendAs ?? []).find((s) => s.isDefault);
  const sendAsEmail = defaultSendAs?.sendAsEmail;
  if (!sendAsEmail) return null;
  const detail = await gmail.users.settings.sendAs.get({ userId: "me", sendAsEmail });
  return detail.data.signature && detail.data.signature.trim() !== "" ? detail.data.signature : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Reads the Gmail address from the OAuth id_token (email scope) instead of
 * calling the Gmail API. `users.getProfile` requires a read scope, which we
 * intentionally do not request — only gmail.send, so `gmail.send` alone
 * yields "Insufficient Permission" on profile.
 */
export function emailFromTokens(tokens: {
  id_token?: string | null;
  email?: string | null;
}): string | null {
  if (tokens.id_token) {
    const payload = decodeJwtPayload(tokens.id_token);
    if (payload && typeof payload["email"] === "string" && payload["email"] !== "") {
      return payload["email"];
    }
  }
  return tokens.email ?? null;
}