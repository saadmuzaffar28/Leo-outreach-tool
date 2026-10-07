import { getSession } from "@/lib/auth";
import { assertSameOrigin, forbidden, jsonResponse, notFound } from "@/lib/http";
import { cancelVerificationBatch } from "@/lib/verification/batch";

export const runtime = "nodejs";

/**
 * POST /api/email-verification/batches/:batchId/cancel
 *
 * Auth → ownership → atomic pending|running→cancelled, with every still-
 * queued job cancelled in the same request. Works even when verification is
 * disabled — getting OUT of a batch must never depend on the feature being on.
 * Terminal batches 409.
 */
export async function POST(req: Request, { params }: { params: { batchId: string } }) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  const result = await cancelVerificationBatch(session.sub, params.batchId);
  if (!result.ok) {
    if (result.reason === "not_found") return notFound("Batch not found");
    return jsonResponse(
      { error: `Batch is ${result.batch.status} and cannot be cancelled`, status: result.batch.status },
      409,
    );
  }

  return jsonResponse({ ok: true, batch: result.batch });
}
