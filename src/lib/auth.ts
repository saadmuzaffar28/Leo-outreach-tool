import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

export const SESSION_COOKIE = "sbs_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  sub: string;
  email: string;
  name?: string | null;
}

const secret = new TextEncoder().encode(env.SESSION_SECRET);

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ email: payload.email, name: payload.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret);
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (!payload.sub) return null;
    return {
      sub: payload.sub,
      email: String(payload.email ?? ""),
      name: payload.name ? String(payload.name) : null,
    };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<SessionPayload | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = await verifySessionToken(token);
  if (!payload) return null;

  // A session must map to a real user row. The JWT (7-day) can outlive its
  // user (e.g. after the dev DB is reset and re-seeded, which assigns the
  // admin a new id). Treat it as logged out so stale sessions can't trigger
  // confusing foreign-key failures or an empty-but-"logged-in" app.
  // (We don't clear the cookie here — cookies() can't be written during
  // server-component rendering; route handlers like the OAuth callback do it.)
  const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true } });
  if (!user) return null;
  return payload;
}

export function setSessionCookie(token: string): void {
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.APP_URL.startsWith("https"),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(): void {
  cookies().set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: env.APP_URL.startsWith("https"),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Returns true only when the session user owns the given resource. */
export function isOwner(session: SessionPayload | null, userId: string): boolean {
  return session !== null && session.sub === userId;
}