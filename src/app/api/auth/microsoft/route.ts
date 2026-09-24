import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  buildAuthorizeUrl,
  microsoftConfigured,
  type MicrosoftConnectMode,
} from "@/lib/microsoft";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { clearSessionCookie, getSession } from "@/lib/auth";

export const runtime = "nodejs";

function toConnectSettings(mode: "normal" | "shared") {
  const url = new URL("/settings", env.APP_URL);
  url.searchParams.set("outlook", mode);
  return url;
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/login", env.APP_URL));

  // A session whose User row no longer exists (e.g. after a DB reset) would
  // burn the one-time code on a failing FK write — log it out first.
  const user = await prisma.user.findUnique({ where: { id: session.sub }, select: { id: true } });
  if (!user) {
    clearSessionCookie();
    return NextResponse.redirect(new URL("/login", env.APP_URL));
  }

  const url = new URL(req.url);
  const mode: MicrosoftConnectMode = url.searchParams.get("mode") === "shared" ? "shared" : "normal";

  // Shared/company mailbox (Mail.Send.Shared) only works for work/school
  // accounts, so shared-mode consent is a distinct path. The selected mode is
  // persisted in the state cookie so the callback knows which scopes to expect.
  if (!microsoftConfigured()) {
    return NextResponse.redirect(toConnectSettings(mode));
  }

  const state = randomUUID();
  const stateValue = JSON.stringify({ state, mode });
  cookies().set("sb_ms_state", stateValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.APP_URL.startsWith("https"),
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(buildAuthorizeUrl(state, mode));
}