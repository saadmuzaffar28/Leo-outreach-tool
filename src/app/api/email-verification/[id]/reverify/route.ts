import { getSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";
import { getVerificationById, reverify } from "@/lib/verification/service";

export const runtime = "nodejs";

/**
 * POST /api/email-verification/:id/reverify
 * Forces a fresh engine run for this record's address (bypasses the cache)
 * by queueing a background job — the UI shows it as queued.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  if (!env.EMAIL_VERIFICATION_ENABLED) {
    return badRequest("Email verification is disabled (EMAIL_VERIFICATION_ENABLED=false)");
  }

  const row = await getVerificationById(session.sub, params.id);
  if (!row) return notFound("Verification not found");

  await reverify(session.sub, row);
  return jsonResponse({ ok: true, queued: true, email: row.email });
}
