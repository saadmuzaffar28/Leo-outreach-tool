import { getSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { forbidden, jsonResponse } from "@/lib/http";
import { cancelVerificationJobs } from "@/lib/verification/worker";

export const runtime = "nodejs";

/**
 * POST /api/email-verification/queue/cancel
 *
 * Atomically transitions all QUEUED jobs belonging to the authenticated
 * user into CANCELLED status.  Jobs that the worker has already claimed
 * (QUEUED → RUNNING) are left untouched — the conditional update only
 * matches rows whose status is still "queued".
 *
 * Returns the number of jobs cancelled and the remaining queued count.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return forbidden();

  if (!env.EMAIL_VERIFICATION_ENABLED) {
    return jsonResponse({ cancelled: 0, remainingQueued: 0 }, 200);
  }

  const { cancelled, remainingQueued } = await cancelVerificationJobs(session.sub);

  return jsonResponse({ cancelled, remainingQueued });
}