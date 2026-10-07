import { getSession } from "@/lib/auth";
import { forbidden, jsonResponse, notFound } from "@/lib/http";
import { getOwnedBatch } from "@/lib/verification/batch";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * GET /api/email-verification/batches/:batchId/jobs?limit=&offset=
 * One batch's queue rows, newest first, ownership-checked like every other
 * batch endpoint: foreign or unknown ids 404, session user only.
 */
export async function GET(req: Request, { params }: { params: { batchId: string } }) {
  const session = await getSession();
  if (!session) return forbidden();

  const batch = await getOwnedBatch(session.sub, params.batchId);
  if (!batch) return notFound("Batch not found");

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const take = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 100, 1), 500);
  const skip = Math.max(Number.isFinite(offset) ? Math.trunc(offset) : 0, 0);

  const [jobs, total] = await Promise.all([
    prisma.verificationJob.findMany({
      where: { batchId: batch.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take,
      skip,
    }),
    prisma.verificationJob.count({ where: { batchId: batch.id } }),
  ]);

  return jsonResponse({
    batchId: batch.id,
    total,
    jobs: jobs.map((job) => ({
      id: job.id,
      email: job.email,
      status: job.status,
      attempts: job.attempts,
      lastError: job.lastError,
      verificationId: job.verificationId,
      nextAttemptAt: job.nextAttemptAt,
      createdAt: job.createdAt,
    })),
  });
}
