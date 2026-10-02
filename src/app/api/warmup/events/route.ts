import { getSession } from "@/lib/auth";
import { badRequest, forbidden, jsonResponse } from "@/lib/http";
import { warmupEventsQuerySchema } from "@/lib/warmup/validation";
import { warmupEvents } from "@/lib/warmup/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/warmup/events — recent warm-up audit trail.
 *
 * SECURITY: the `meta` column is written by the worker and never contains
 * credentials, message bodies or recipient addresses beyond enrolled pool
 * mailboxes.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return forbidden();

  const url = new URL(req.url);
  const parsed = warmupEventsQuerySchema.safeParse({
    mailboxId: url.searchParams.get("mailboxId") ?? undefined,
    type: url.searchParams.get("type") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid query");
  }

  const events = await warmupEvents(session.sub, parsed.data);
  return jsonResponse({ events });
}