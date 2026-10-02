import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { buildAuthUrl, generateCodeChallenge, generateCodeVerifier } from "@/lib/google";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { clearSessionCookie, getSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) {
    const url = new URL("/login", env.APP_URL);
    return NextResponse.redirect(url);
  }

  // A session whose User row no longer exists (e.g. after a DB reset) would
  // burn the one-time code on a failing FK write — log it out first.
  const user = await prisma.user.findUnique({ where: { id: session.sub }, select: { id: true } });
  if (!user) {
    clearSessionCookie();
    const url = new URL("/login", env.APP_URL);
    return NextResponse.redirect(url);
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    const url = new URL("/settings", env.APP_URL);
    url.searchParams.set("google", "error");
    url.searchParams.set("reason", "Google OAuth is not configured");
    return NextResponse.redirect(url);
  }

  const state = randomUUID();
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);

  cookies().set("sb_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.APP_URL.startsWith("https"),
    path: "/",
    maxAge: 600,
  });
  cookies().set("sb_oauth_verifier", verifier, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.APP_URL.startsWith("https"),
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(buildAuthUrl(state, challenge));
}