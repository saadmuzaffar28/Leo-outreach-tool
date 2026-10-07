import { getSession } from "@/lib/auth";
import { forbidden, jsonResponse, notFound } from "@/lib/http";
import { getOwnedBatch, refreshBatch } from "@/lib/verification/batch";

export const runtime = "nodejs";

/**
 * GET /api/email-verification/batches/:batchId
 * One batch, counters freshly recomputed from its jobs. Foreign or unknown
 * ids 404 — ownership is `session.sub === batch.userId`, never a client id.
 */
export async function GET(_req: Request, { params }: { params: { batchId: string } }) {
  const session = await getSession();
  if (!session) return forbidden();

  const batch = await getOwnedBatch(session.sub, params.batchId);
  if (!batch) return notFound("Batch not found");

  const fresh = (await refreshBatch(batch.id)) ?? batch;
  return jsonResponse({ batch: fresh });
}
