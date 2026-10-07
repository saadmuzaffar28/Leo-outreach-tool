import { getSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { verificationBatchCreateSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse } from "@/lib/http";
import { BatchError, createVerificationBatch, listVerificationBatches } from "@/lib/verification/batch";

export const runtime = "nodejs";

/**
 * POST /api/email-verification/batches
 * Body: { filename, emails: string[], force? }
 *
 * "Verify File" — the ONLY place a batch and its jobs come into existence.
 * The upload/parse step creates nothing; this call creates everything in one
 * transaction and stops there: status "pending", no worker started, no
 * engine touched. userId comes from the session — the body is never trusted.
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

  const parsed = verificationBatchCreateSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid request");

  try {
    const { batch, created, invalidFormat, duplicates } = await createVerificationBatch(session.sub, {
      filename: parsed.data.filename,
      emails: parsed.data.emails,
      force: parsed.data.force,
    });
    return jsonResponse(
      { ok: true, batchId: batch.id, batch, created, invalidFormat, duplicates },
      201,
    );
  } catch (err) {
    if (err instanceof BatchError) return badRequest(err.message);
    throw err;
  }
}

/** GET /api/email-verification/batches — the session user's batches, newest first. */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return forbidden();

  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 20);
  const batches = await listVerificationBatches(session.sub, Number.isFinite(limit) ? limit : 20);
  return jsonResponse({ batches });
}
