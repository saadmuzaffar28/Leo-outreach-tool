import { getSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";
import { startVerificationBatch } from "@/lib/verification/batch";
import { kickBatchWorker } from "@/lib/verification/worker";

export const runtime = "nodejs";

/**
 * POST /api/email-verification/batches/:batchId/start
 *
 * Auth → ownership → atomic pending→running → kick the batch-scoped loop.
 * Only THIS batch's jobs become claimable; the legacy (batchId null) queue
 * and every other batch are untouched by construction.
 *
 * Idempotent while running: a second start re-kicks the (guarded) loop,
 * which is how a batch resumes after a process restart. Terminal batches
 * (completed/cancelled/failed) 409.
 */
export async function POST(req: Request, { params }: { params: { batchId: string } }) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  if (!env.EMAIL_VERIFICATION_ENABLED) {
    return badRequest("Email verification is disabled (EMAIL_VERIFICATION_ENABLED=false)");
  }

  const result = await startVerificationBatch(session.sub, params.batchId);
  if (!result.ok) {
    if (result.reason === "not_found") return notFound("Batch not found");
    return jsonResponse(
      { error: `Batch is ${result.batch.status} and cannot be started`, status: result.batch.status },
      409,
    );
  }

  kickBatchWorker(result.batch.id);
  return jsonResponse({ ok: true, batch: result.batch, alreadyRunning: result.alreadyRunning });
}
