import { getSession } from "@/lib/auth";
import { forbidden, jsonResponse } from "@/lib/http";
import { verificationStats } from "@/lib/verification/service";

export const runtime = "nodejs";

/** GET /api/email-verification/stats — per-user totals for the bulk UI. */
export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();

  const stats = await verificationStats(session.sub);
  return jsonResponse({ stats });
}
