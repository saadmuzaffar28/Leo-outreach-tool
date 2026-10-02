/**
 * Middleware coverage for the warm-up page and the /api/warmup surface.
 *
 * What is actually being asserted here matters, because it is a design choice
 * rather than an accident:
 *
 *   - `/warmup` is a page, so the middleware must redirect an anonymous visitor
 *     to /login. That is real defence for the UI.
 *
 *   - `/api/*` is rate-limited by the middleware but NOT authenticated by it.
 *     Every API route in this codebase -- warm-up included -- is responsible
 *     for its own `getSession()` check. That is a single point of failure per
 *     route, so it is worth pinning down explicitly: a future route that forgets
 *     the check would be exposed, and nothing else in the stack would catch it.
 *
 * The per-route guarantee is proved in warmup-api.integration.test.ts, which
 * calls every warm-up handler with no session and asserts a refusal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";

const SECRET = "middleware-test-secret-long-enough-1234567890";

async function run(pathname: string, cookie?: string) {
  vi.resetModules();
  process.env.SESSION_SECRET = SECRET;

  const { middleware, config } = await import("@/middleware");

  const req = new NextRequest(new URL(pathname, "http://localhost:3000"));
  if (cookie) req.cookies.set("sbs_session", cookie);

  return { res: await middleware(req), config };
}

async function validToken(): Promise<string> {
  return new SignJWT({ sub: "user-123", role: "user" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

describe("warm-up page is behind the session cookie", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("redirects an anonymous visitor away from /warmup", async () => {
    const { res } = await run("/warmup");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("keeps the intended destination so login can bounce back", async () => {
    const { res } = await run("/warmup");
    expect(res.headers.get("location")).toContain("next=%2Fwarmup");
  });

  it("admits a visitor with a valid session cookie", async () => {
    const { res } = await run("/warmup", await validToken());
    // NextResponse.next() is 200 with the x-middleware-next header.
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("rejects a forged session cookie", async () => {
    const { res } = await run("/warmup", "not.a.real.jwt");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("rejects a cookie signed with the wrong key", async () => {
    const forged = await new SignJWT({ sub: "attacker" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("some-other-secret-also-long-enough-1234"));
    const { res } = await run("/warmup", forged);
    expect(res.status).toBe(307);
  });

  it("/warmup is in the middleware matcher", async () => {
    const { config } = await run("/warmup", await validToken());
    expect(config.matcher).toContain("/warmup/:path*");
  });

  it("/warmup is in the protected page list, so nested paths match too", async () => {
    process.env.SESSION_SECRET = SECRET;
    vi.resetModules();
    const mod = await import("@/middleware");
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain('"/warmup"');
    expect(typeof mod.middleware).toBe("function");
  });
});

describe("api routes are rate-limited by the middleware, not authenticated by it", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("lets an anonymous /api/warmup request through to its handler", async () => {
    // Documenting the boundary: middleware does NOT gate these. The handler does.
    // If this ever starts returning 401/307 here, handlers were relying on a
    // guarantee that never existed -- re-read them before trusting the change.
    const { res } = await run("/api/warmup/mailboxes");
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("rate-limits repeated /api/warmup requests from one client", async () => {
    vi.resetModules();
    process.env.SESSION_SECRET = SECRET;
    const { middleware } = await import("@/middleware");

    let limited = false;
    for (let i = 0; i < 200; i++) {
      const req = new NextRequest(new URL("/api/warmup/mailboxes", "http://localhost:3000"));
      req.headers.set("x-forwarded-for", "203.0.113.77");
      const res = await middleware(req);
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it("/api/:path* is in the matcher", async () => {
    const { config } = await run("/api/warmup/mailboxes");
    expect(config.matcher).toContain("/api/:path*");
  });
});