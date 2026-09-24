import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

export const SESSION_COOKIE = "sbs_session";

const PROTECTED_PAGES = ["/sms", "/dashboard", "/leads", "/templates", "/campaigns", "/settings"];

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const ipBuckets = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = ipBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    ipBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) return true;
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Rate limiting for API endpoints (web UI + imports).
  if (pathname.startsWith("/api/")) {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "local";
    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: "Too many requests. Please slow down and try again shortly." },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/_next") || pathname.includes(".")) return NextResponse.next();

  // Protect app pages.
  if (PROTECTED_PAGES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"))) {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (!token) {
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
    try {
      await jwtVerify(token, new TextEncoder().encode(process.env.SESSION_SECRET ?? ""));
    } catch {
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/sms/:path*", "/dashboard/:path*", "/leads/:path*", "/templates/:path*", "/campaigns/:path*", "/settings/:path*", "/api/:path*"],
};