import { getSession } from "@/lib/auth";
import { assertSameOrigin, forbidden, jsonResponse, notFound } from "@/lib/http";
import { resetWarmup } from "@/lib/warmup/service";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/warmup/mailboxes/[id]/reset — return the ramp to day 1.
 *
 * Cancels queued jobs and releases their reserved shared-budget slots, so a
 * reset cannot strand daily budget that campaigns would otherwise be denied.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();
  const { id } = await params;

  const account = await prisma.smtpAccount.findUnique({ where: { id } });
  if (!account || account.userId !== session.sub) return notFound();

  const result = await resetWarmup(session.sub, id);
  return jsonResponse(result);
}