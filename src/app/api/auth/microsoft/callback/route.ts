import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { clearSessionCookie, getSession } from "@/lib/auth";
import {
  encryptMicrosoftTokens,
  exchangeAuthorizationCode,
  fetchGraphProfile,
} from "@/lib/microsoft";

export const runtime = "nodejs";

function redirectToSettings(outlook: string, reason?: string) {
  const url = new URL("/settings", env.APP_URL);
  url.searchParams.set("outlook", outlook);
  if (reason) url.searchParams.set("reason", reason);
  return NextResponse.redirect(url);
}

/** True when this user already has an account that was just connected (replayed callback). */
function recentlyConnectedAcct(userId: string) {
  return prisma.microsoftAccount.findFirst({
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
  if (!session) return NextResponse.redirect(new URL("/login", env.APP_URL));

  // The JWT session may outlive its User row (e.g. after the dev DB was reset
  // and re-seeded). A stale session would burn the one-time code — log out.
  const user = await prisma.user.findUnique({ where: { id: session.sub }, select: { id: true } });
  if (!user) {
    clearSessionCookie();
    return NextResponse.redirect(new URL("/login", env.APP_URL));
  }

  const savedState = cookies().get("sb_ms_state")?.value;
  cookies().set("sb_ms_state", "", { maxAge: 0, path: "/" });

  if (oauthError || !code || !savedState || savedState !== state) {
    // Same-page replay of an already-successful callback (dev restart, refresh).
    if (await recentlyConnectedAcct(session.sub)) return redirectToSettings("connected");
    const reason = oauthError
      ? `Microsoft returned: ${oauthError}`
      : !code
        ? "no authorization code returned"
        : !savedState
          ? "no fresh OAuth session found — click Connect Outlook again"
          : "state mismatch (likely different host or cookie blocked)";
    return redirectToSettings("error", reason);
  }

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode(code);
  } catch (err) {
    console.error("[auth/microsoft/callback] token exchange", err);
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("invalid_grant") && (await recentlyConnectedAcct(session.sub))) {
      return redirectToSettings("connected");
    }
    const reason = message.includes("invalid_client")
      ? "invalid client credentials - MICROSOFT_CLIENT_SECRET in .env must match the Entra app registration"
      : message.includes("redirect_uri_mismatch")
        ? `redirect URI mismatch - register ${env.MICROSOFT_REDIRECT_URI || env.APP_URL + "/api/auth/microsoft/callback"} as a Web redirect URI in the Entra app`
        : message.includes("invalid_grant")
          ? "invalid grant - the code was already used or expired. Click Connect Outlook to start a fresh authorization."
          : `token exchange failed: ${message}`;
    return redirectToSettings("error", reason);
  }

  let profile;
  try {
    profile = await fetchGraphProfile(tokens.accessToken);
  } catch (err) {
    console.error("[auth/microsoft/callback] /me profile", err);
    const message = err instanceof Error ? err.message : String(err);
    return redirectToSettings("error", `could not read the Microsoft account profile: ${message}`);
  }

  if (!profile.email) {
    return redirectToSettings("error", "no email address returned by Microsoft — cannot use this account to send");
  }

  const stored = encryptMicrosoftTokens(tokens);
  const existing = await prisma.microsoftAccount.findFirst({
    where: { userId: session.sub, microsoftEmail: profile.email },
  });

  let accountId: string;
  if (existing) {
    await prisma.microsoftAccount.update({
      where: { id: existing.id },
      data: {
        ...stored,
        displayName: profile.displayName,
        providerAccountId: profile.id,
      },
    });
    accountId = existing.id;
  } else {
    const created = await prisma.microsoftAccount.create({
      data: {
        userId: session.sub,
        microsoftEmail: profile.email,
        displayName: profile.displayName ?? null,
        providerAccountId: profile.id,
        ...stored,
        scopes: ["openid", "profile", "email", "offline_access", "User.Read", "Mail.Send"],
      },
    });
    accountId = created.id;
  }

  // Re-link campaigns that lost their sender (neither Gmail nor Outlook set).
  await prisma.campaign.updateMany({
    where: { userId: session.sub, googleAccountId: null, microsoftAccountId: null },
    data: { microsoftAccountId: accountId },
  });

  return redirectToSettings("connected");
}