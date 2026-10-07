import { getSession } from "@/lib/auth";
import { forbidden, badRequest, jsonResponse } from "@/lib/http";
import { verificationListQuerySchema } from "@/lib/validation";
import { listVerifications, rowToResult } from "@/lib/verification/service";

export const runtime = "nodejs";

/**
 * GET /api/email-verification/list?status=&q=&limit=&offset=
 * Paginated, filterable verification history for the session user only.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return forbidden();

  const url = new URL(req.url);
  const parsed = verificationListQuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined,
  });
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid query");

  const { rows, total } = await listVerifications(session.sub, parsed.data);
  return jsonResponse({
    rows: rows.map((row) => ({ id: row.id, ...rowToResult(row), checkedAt: row.checkedAt.toISOString(), expiresAt: row.expiresAt.toISOString() })),
    total,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
  });
}
