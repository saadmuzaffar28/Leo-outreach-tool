import { getSession } from "@/lib/auth";
import { forbidden, notFound, jsonResponse } from "@/lib/http";
import { getVerificationById, rowToResult } from "@/lib/verification/service";

export const runtime = "nodejs";

/**
 * GET /api/email-verification/:id
 * One stored result, scoped to the session user (foreign ids 404).
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return forbidden();

  const row = await getVerificationById(session.sub, params.id);
  if (!row) return notFound("Verification not found");

  return jsonResponse({
    verification: {
      id: row.id,
      ...rowToResult(row),
      checkedAt: row.checkedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    },
  });
}
