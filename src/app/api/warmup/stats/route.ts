import { getSession } from "@/lib/auth";
import { badRequest, forbidden, jsonResponse } from "@/lib/http";
import { warmupStatsQuerySchema } from "@/lib/warmup/validation";
import { warmupStats } from "@/lib/warmup/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/warmup/stats?days=7|30 — aggregate warm-up metrics plus a chart
 * series. `days` is validated to 1..90.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return forbidden();

  const url = new URL(req.url);
  const parsed = warmupStatsQuerySchema.safeParse({
    days: url.searchParams.get("days") ?? undefined,
    mailboxId: url.searchParams.get("mailboxId") ?? undefined,
  });
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid query");
  }

  const stats = await warmupStats(session.sub, parsed.data.days, parsed.data.mailboxId);
  return jsonResponse({ stats });
}