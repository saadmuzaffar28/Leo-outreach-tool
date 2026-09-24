// Microsoft Outlook OAuth 2.0 + Microsoft Graph integration (server-side only).
// Authorization Code flow against the Microsoft identity platform v2 endpoint;
// tokens are encrypted at rest with the same AES-256-GCM helper as Gmail.
//
// Two connect modes:
//   "normal" — delegated Mail.Send on the signed-in user's OWN mailbox,
//              sends via POST /me/sendMail (saveToSentItems: true).
//   "shared" — delegated Mail.Send.Shared so the signed-in user (who holds
//              Send As / Send on Behalf on a shared/company mailbox) can send
//              FROM that mailbox. The shared mailbox address is ONLY ever a
//              message-level from override — it is NEVER used to authenticate,
//              and the app never requests its password. The signed-in delegate
//              must authenticate (once) and must have the mailbox permission.

import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { decrypt, encrypt } from "@/lib/encryption";
import type { MailMessage } from "@/lib/message";
import { htmlBody } from "@/lib/message";

export const MICROSOFT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.Send",
].join(" ");

/**
 * Scopes for connecting a shared/company mailbox. Adds delegated
 * `Mail.Send.Shared` so the signed-in delegate (who has **Send As** or
 * **Send on Behalf** rights on the shared mailbox) can send FROM it via
 * `/me/sendMail` with `message.from` set. Only consentable for work/school
 * accounts — personal accounts cannot grant it, which is why this is a
 * separate connect mode rather than an extra scope on the normal path.
 */
export const MICROSOFT_SHARED_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.Send",
  "Mail.Send.Shared",
].join(" ");

/** Chosen at connect time; "normal" = own mailbox, "shared" = company mailbox. */
export type MicrosoftConnectMode = "normal" | "shared";

export function microsoftScopesFor(mode: MicrosoftConnectMode): string {
  return mode === "shared" ? MICROSOFT_SHARED_SCOPES : MICROSOFT_SCOPES;
}

const AUTHORITY = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";

export const GRAPH_SENT_MARKER = "microsoft-graph";

/** Error thrown by Graph/identity calls with a status code the queue can classify. */
export class MicrosoftGraphError extends Error {
  status: number;
  code: number;
  reason?: string;
  retryAfterSeconds?: number;

  constructor(status: number, message: string, reason?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "MicrosoftGraphError";
    this.status = status;
    this.code = status;
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface MicrosoftTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export interface DecryptedMicrosoftAccount {
  id: string;
  userId: string;
  microsoftEmail: string;
  displayName: string | null;
  connectMode: MicrosoftConnectMode;
  sendFromEmail: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export interface MicrosoftEncryptedTokens {
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  expiresAt: Date | null;
}

export function microsoftConfigured(): boolean {
  return env.MICROSOFT_CLIENT_ID !== "" && env.MICROSOFT_CLIENT_SECRET !== "";
}

export function microsoftRedirectUri(): string {
  return (
    env.MICROSOFT_REDIRECT_URI ||
    `${env.APP_URL.replace(/\/$/, "")}/api/auth/microsoft/callback`
  );
}

function tokenEndpoint(): string {
  return `${AUTHORITY}/${env.MICROSOFT_TENANT_ID || "common"}/oauth2/v2.0/token`;
}

/** Decrypted Microsoft OAuth tokens — only ever constructed server-side. */
export function decryptMicrosoftAccount(account: {
  id: string;
  userId: string;
  microsoftEmail: string;
  displayName: string | null;
  connectMode: string;
  sendFromEmail: string | null;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  expiresAt: Date | null;
}): DecryptedMicrosoftAccount {
  return {
    id: account.id,
    userId: account.userId,
    microsoftEmail: account.microsoftEmail,
    displayName: account.displayName,
    connectMode: account.connectMode === "shared" ? ("shared" as MicrosoftConnectMode) : ("normal" as MicrosoftConnectMode),
    sendFromEmail: account.sendFromEmail,
    accessToken: decrypt(account.accessTokenEncrypted),
    refreshToken: account.refreshTokenEncrypted ? decrypt(account.refreshTokenEncrypted) : null,
    expiresAt: account.expiresAt,
  };
}

export function encryptMicrosoftTokens(tokens: MicrosoftTokens): MicrosoftEncryptedTokens {
  return {
    accessTokenEncrypted: encrypt(tokens.accessToken),
    refreshTokenEncrypted: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
    expiresAt: tokens.expiresAt,
  };
}

/** Authorization URL the browser is redirected to on "Connect Outlook". */
export function buildAuthorizeUrl(state: string, mode: MicrosoftConnectMode = "normal"): string {
  const params = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID,
    response_type: "code",
    redirect_uri: microsoftRedirectUri(),
    response_mode: "query",
    scope: microsoftScopesFor(mode),
    state,
    nonce: randomUUID(),
    prompt: "select_account",
  });
  return `${AUTHORITY}/${env.MICROSOFT_TENANT_ID || "common"}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function postToken(form: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID,
    client_secret: env.MICROSOFT_CLIENT_SECRET,
    ...form,
  });
  const res = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { error?: string; error_description?: string };
      detail = [j.error, j.error_description].filter(Boolean).join(": ") || res.statusText;
    } catch {
      /* keep statusText */
    }
    throw new MicrosoftGraphError(res.status, detail);
  }
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (data.error) {
    const detail = `${data.error}: ${data.error_description ?? ""}`;
    throw new MicrosoftGraphError(400, detail, data.error);
  }
  return data;
}

function toMicrosoftTokens(data: Record<string, unknown>, fallbackRefresh?: string): MicrosoftTokens {
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : fallbackRefresh ?? null;
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 0;
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
  };
}

/** Exchanges the authorization code for tokens. */
export async function exchangeAuthorizationCode(code: string): Promise<MicrosoftTokens> {
  const data = await postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: microsoftRedirectUri(),
    scope: MICROSOFT_SCOPES,
  });
  return toMicrosoftTokens(data);
}

/**
 * Refreshes tokens. Microsoft rotates refresh tokens, so callers must persist
 * the returned refresh token (when present) alongside the new access token.
 */
export async function refreshMicrosoftTokens(refreshToken: string): Promise<MicrosoftTokens> {
  const data = await postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: MICROSOFT_SCOPES,
  });
  return toMicrosoftTokens(data, refreshToken);
}

/** Fetches the signed-in user's profile from Microsoft Graph. */
export async function fetchGraphProfile(
  accessToken: string,
): Promise<{ id?: string; displayName: string | null; email: string }> {
  const res = await fetch(`${GRAPH}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      detail = [j.error?.code, j.error?.message].filter(Boolean).join(": ") || res.statusText;
    } catch {
      /* keep statusText */
    }
    throw new MicrosoftGraphError(res.status, detail);
  }
  const data = (await res.json()) as {
    id?: string;
    displayName?: string;
    mail?: string | null;
    userPrincipalName?: string | null;
  };
  const email = (data.mail || data.userPrincipalName || "").trim().toLowerCase();
  if (!email) {
    throw new MicrosoftGraphError(400, "Microsoft Graph returned no email address for this account");
  }
  return { id: data.id, displayName: data.displayName ?? null, email };
}

/**
 * Returns a usable access token for a stored account, refreshing first when it
 * is missing or within 5 minutes of expiry. Returns refreshed tokens for the
 * caller to persist (Microsoft rotates refresh tokens on refresh).
 */
export async function getAuthorizedMicrosoft(
  account: DecryptedMicrosoftAccount,
): Promise<{ accessToken: string; refreshedTokens: MicrosoftTokens | null }> {
  const expiresAt = account.expiresAt ? new Date(account.expiresAt).getTime() : 0;
  const nearExpiry = Date.now() > expiresAt - 5 * 60 * 1000;
  if ((nearExpiry || account.accessToken === "") && account.refreshToken) {
    const refreshed = await refreshMicrosoftTokens(account.refreshToken);
    return { accessToken: refreshed.accessToken, refreshedTokens: refreshed };
  }
  return { accessToken: account.accessToken, refreshedTokens: null };
}

/**
 * Sends a single email via Microsoft Graph as the connected user
 * (`POST /me/sendMail`, saved to Sent Items). When `sendFromEmail` is set the
 * send is made FROM that mailbox — used for shared/company mailboxes where the
 * connected delegate holds Send As / Send on Behalf rights (Mail.Send.Shared).
 * It is ONLY a send-side from override and is never used to authenticate.
 * Throws MicrosoftGraphError on failure so the send queue can classify/retry.
 */
export async function sendMicrosoftMail(
  accessToken: string,
  msg: MailMessage,
  opts?: { sendFromEmail?: string },
): Promise<void> {
  const internetMessageHeaders: Array<{ name: string; value: string }> = [];
  if (msg.unsubscribeUrl) {
    internetMessageHeaders.push(
      { name: "List-Unsubscribe", value: `<${msg.unsubscribeUrl}>` },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    );
  }

  const payload: Record<string, unknown> = {
    message: {
      subject: msg.subject,
      body: {
        contentType: "HTML",
        content: htmlBody(msg),
      },
      toRecipients: [{ emailAddress: { address: msg.to } }],
      ...(internetMessageHeaders.length > 0 ? { internetMessageHeaders } : {}),
    },
    saveToSentItems: true,
  };

  const sendFromEmail = opts?.sendFromEmail?.trim().toLowerCase();
  // Delegated Graph: `/me/sendMail` sends as the connected user unless `from`
  // is supplied, in which case it sends FROM that shared mailbox address
  // (requires the connected user to hold Send As / Send on Behalf on it).
  if (sendFromEmail) {
    const messageObject = (payload.message ?? {}) as Record<string, unknown>;
    payload.message = { ...messageObject, from: { emailAddress: { address: sendFromEmail } } };
  }

  const res = await fetch(`${GRAPH}/me/sendMail`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = res.statusText;
    let reason: string | undefined;
    let retryAfter: number | undefined;
    const retryAfterHeader = res.headers.get("Retry-After");
    if (retryAfterHeader) {
      const parsed = Number(retryAfterHeader);
      if (Number.isFinite(parsed) && parsed > 0) retryAfter = parsed;
    }
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      reason = j.error?.code;
      detail = [j.error?.code, j.error?.message].filter(Boolean).join(": ") || res.statusText;
    } catch {
      /* keep statusText */
    }
    throw new MicrosoftGraphError(res.status, detail, reason, retryAfter);
  }
}