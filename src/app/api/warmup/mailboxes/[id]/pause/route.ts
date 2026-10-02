import { getSession } from "@/lib/auth";
import { assertSameOrigin, forbidden, jsonResponse, notFound } from "@/lib/http";
import { pauseWarmup } from "@/lib/warmup/service";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** POST /api/warmup/mailboxes/[id]/pause — pause warm-up without losing config. */
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

  const result = await pauseWarmup(session.sub, id);
  return jsonResponse(result);
}