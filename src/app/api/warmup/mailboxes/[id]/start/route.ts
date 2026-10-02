import { getSession } from "@/lib/auth";
import { assertSameOrigin, forbidden, jsonResponse, notFound } from "@/lib/http";
import { startWarmup } from "@/lib/warmup/service";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** POST /api/warmup/mailboxes/[id]/start — enrol/enable warm-up for a mailbox. */
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

  const result = await startWarmup(session.sub, id);
  return jsonResponse(result, result.ok ? 200 : 409);
}