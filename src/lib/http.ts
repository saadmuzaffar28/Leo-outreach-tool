import { env } from "@/lib/env";

export function isJsonRequest(req: Request): boolean {
  return req.headers.get("content-type")?.includes("application/json") ?? false;
}

/**
 * Origins permitted to make state-changing requests.
 *
 * This is APP_URL plus any extra origins named in ALLOWED_ORIGINS. Entries are
 * compared as parsed origins (scheme + host + port), so "http://localhost:3010/"
 * and "http://localhost:3010" are the same entry. Unparseable entries are
 * ignored rather than failing startup.
 */
export function buildAllowedOrigins(appUrl: string, allowedOrigins: string): Set<string> {
  const allowed = new Set<string>();
  for (const candidate of [appUrl, ...allowedOrigins.split(",")]) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      const origin = new URL(trimmed).origin;
      // A parsed-but-opaque URL yields the literal string "null"; never allow it.
      if (origin && origin !== "null") allowed.add(origin);
    } catch {
      // ignore malformed entry
    }
  }
  return allowed;
}

/**
 * Lightweight CSRF/origin defence for state-changing endpoints.
 * Non-browser clients (no Origin header) are skipped; browsers must send
 * APP_URL's origin or one explicitly allowed via ALLOWED_ORIGINS.
 */
export function assertSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let actual: string;
  try {
    actual = new URL(origin).origin;
  } catch {
    return false;
  }
  // Opaque origins (sandboxed iframes, some file:// contexts) send "null".
  if (!actual || actual === "null") return false;
  return buildAllowedOrigins(env.APP_URL, env.ALLOWED_ORIGINS).has(actual);
}

export function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function unauthorized(message = "Not authorized") {
  return jsonResponse({ error: message }, 401);
}

export function forbidden(message = "Forbidden") {
  return jsonResponse({ error: message }, 403);
}

export function notFound(message = "Not found") {
  return jsonResponse({ error: message }, 404);
}

export function badRequest(message: string) {
  return jsonResponse({ error: message }, 400);
}

export function serverError(message = "Something went wrong") {
  return jsonResponse({ error: message }, 500);
}