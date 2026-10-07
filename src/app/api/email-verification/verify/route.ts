import { getSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { verificationVerifySchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse } from "@/lib/http";
import { verifySingle } from "@/lib/verification/service";

export const runtime = "nodejs";

/**
 * POST /api/email-verification/verify
 * Body: { email: string, force?: boolean }
 *
 * Single, synchronous verification (individual check from the lead UI).
 * Authenticated; origin-checked; the global /api IP rate limit applies.
 * Results are cached (EMAIL_VERIFICATION_CACHE_TTL_DAYS) unless `force`.
 */
export async function POST(req: Request) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  if (!env.EMAIL_VERIFICATION_ENABLED) {
    return badRequest("Email verification is disabled (EMAIL_VERIFICATION_ENABLED=false)");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const parsed = verificationVerifySchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid email");

  try {
    const outcome = await verifySingle(session.sub, parsed.data.email, {
      force: parsed.data.force === true,
    });
    return jsonResponse({
      verification: outcome.result,
      id: outcome.row?.id ?? null,
      cached: outcome.cached,
      // Explicit, never implied as a guarantee by the UI copy.
      disclaimer: "Deliverable means likely deliverable — not a guarantee of inbox placement.",
    });
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "Invalid email");
  }
}
