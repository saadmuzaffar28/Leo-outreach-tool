import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { clearSessionCookie, getSession } from "@/lib/auth";
import { encryptTokens, exchangeCode, emailFromTokens, fetchGmailSignature, getOAuthClient, mergeStoredTokens, GMAIL_SEND_SCOPE, GMAIL_SETTINGS_BASIC_SCOPE } from "@/lib/google";

export const runtime = "nodejs";

function redirectToSettings(error: string | null, reason?: string) {
  const url = new URL("/settings", env.APP_URL);
  if (error) url.searchParams.set("google", error);
  else url.searchParams.set("google", "connected");
  if (reason) url.searchParams.set("reason", reason);
  return NextResponse.redirect(url);
}

/**
 * The JWT session may outlive its User row (e.g. after the dev DB was reset and
 * re-seeded, which assigns the admin a new id). A stale session would burn the
 * single-use authorization code on a failing FK write, so we resolve the real
 * user before touching the code.
 */
async function ensureSessionUser(session: { sub: string } | null) {
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.sub }, select: { id: true } });
  return user ?? null;
}

/** True when this user already has an account that was just connected (replayed callback). */
function recentlyConnectedAcct(userId: string) {
  return prisma.googleAccount.findFirst({
    where: { userId, updatedAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } },
    select: { id: true },
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const session = await getSession();
  if (!session) {
    const loginUrl = new URL("/login", env.APP_URL);
    return NextResponse.redirect(loginUrl);
  }

  // Stale session? Log it out before any code is consumed.
  if (!(await ensureSessionUser(session))) {
    clearSessionCookie();
    const loginUrl = new URL("/login", env.APP_URL);
    return NextResponse.redirect(loginUrl);
  }

  const savedState = cookies().get("sb_oauth_state")?.value;
  const verifier = cookies().get("sb_oauth_verifier")?.value;
  cookies().set("sb_oauth_state", "", { maxAge: 0, path: "/" });
  cookies().set("sb_oauth_verifier", "", { maxAge: 0, path: "/" });

  if (oauthError || !code || !verifier || !savedState || savedState !== state) {
    // Same-page replay of an already-successful callback (dev restart, refresh).
    if (await recentlyConnectedAcct(session.sub)) return redirectToSettings(null);
    const reason = oauthError
      ? `google:${oauthError}`
      : !code
        ? "no authorization code returned"
        : !verifier || !savedState
          ? "no fresh OAuth session found — click Connect Gmail again"
          : "state mismatch (likely different host or cookie blocked)";
    return redirectToSettings("error", reason);
  }

  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  let email: string;
  try {
    tokens = await exchangeCode(code, verifier);
  } catch (err) {
    console.error("[google/callback] token exchange", err);
    const message = err instanceof Error ? err.message : String(err);
    // The one-time code was already redeemed — most often a replayed callback
    // after the first attempt succeeded. If the account is present, that's success.
    if (message.includes("invalid_grant") && (await recentlyConnectedAcct(session.sub))) {
      return redirectToSettings(null);
    }
    const reason = message.includes("invalid_client")
      ? "invalid client credentials - GOOGLE_CLIENT_SECRET in .env must match Google Cloud Console"
      : message.includes("redirect_uri_mismatch")
        ? "redirect URI mismatch - register http://localhost:3002/api/google/callback as an authorized redirect URI"
        : message.includes("invalid_grant")
          ? "invalid grant - the code was already used or expired. Click Connect Gmail to start a fresh authorization."
          : `token exchange failed: ${message}`;
    return redirectToSettings("error", reason);
  }

  const grantedScopes = (tokens.scope ?? "").split(" ");
  if (!grantedScopes.some((s) => s === GMAIL_SEND_SCOPE)) {
    console.error("[google/callback] gmail.send not granted. scopes:", grantedScopes.join(", "));
    return redirectToSettings(
      "error",
      `Google did not grant the Gmail-send scope. Granted: ${grantedScopes.join(", ") || "none"} - re-auth from the Connect button and grant all requested permissions; if using a business Google account, its admin may block Gmail access for unverified apps.`,
    );
  }

  email = emailFromTokens(tokens) ?? "";
  if (!email) return redirectToSettings("error", "no email in id_token - request the email scope");

  // Grab the account's Gmail signature (default send-as) when settings access was granted.
  let signature: string | null = null;
  if (grantedScopes.some((s) => s === GMAIL_SETTINGS_BASIC_SCOPE)) {
    try {
      const oauth = getOAuthClient(tokens.access_token ?? undefined, tokens.refresh_token ?? undefined);
      signature = await fetchGmailSignature(oauth);
    } catch (err) {
      console.error("[google/callback] signature fetch", err);
    }
  }

  const stored = encryptTokens(tokens);

  // Match on (userId, googleEmail): authorizing a DIFFERENT Google account
  // creates a new record, while re-authorizing one we already hold refreshes
  // that record in place. Nothing here can overwrite another account.
  const existing = await prisma.googleAccount.findFirst({
    where: { userId: session.sub, googleEmail: email },
  });
  let accountId: string;
  if (existing) {
    await prisma.googleAccount.update({
      where: { id: existing.id },
      data: {
        // Never drop a refresh token we already hold -- Google frequently
        // omits it from the response for an already-approved app.
        ...mergeStoredTokens(stored, existing),
        scopes: tokens.scope?.split(" ") ?? [],
        signature,
        // A successful authorization proves the grant is good again.
        status: "connected",
        statusMessage: null,
      },
    });
    accountId = existing.id;
  } else {
    const created = await prisma.googleAccount.create({
      data: {
        userId: session.sub,
        googleEmail: email,
        ...stored,
        scopes: tokens.scope?.split(" ") ?? [],
        signature,
        status: "connected",
        statusMessage: null,
      },
    });
    accountId = created.id;
  }

  // Legacy repair: campaigns created before a sending account could be chosen
  // get bound to the user's FIRST Gmail connection. Once several accounts are
  // connected this must not run again -- a later connect would otherwise claim
  // senderless campaigns that were not really its own.
  const googleAccountCount = await prisma.googleAccount.count({ where: { userId: session.sub } });
  if (googleAccountCount === 1) {
    await prisma.campaign.updateMany({
      where: { userId: session.sub, googleAccountId: null, microsoftAccountId: null },
      data: { googleAccountId: accountId },
    });
  }

  return redirectToSettings(null);
}