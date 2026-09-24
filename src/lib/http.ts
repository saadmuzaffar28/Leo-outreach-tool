import { env } from "@/lib/env";

export function isJsonRequest(req: Request): boolean {
  return req.headers.get("content-type")?.includes("application/json") ?? false;
}

/**
 * Lightweight CSRF/origin defence for state-changing endpoints.
 * Non-browser clients (no Origin header) are skipped; browsers must send the same origin.
 */
export function assertSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(env.APP_URL).origin;
  } catch {
    return false;
  }
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