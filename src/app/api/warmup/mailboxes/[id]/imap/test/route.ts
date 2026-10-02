import { getSession } from "@/lib/auth";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { imapConfigFor, probeImap } from "@/lib/warmup/imap";

export const dynamic = "force-dynamic";

/**
 * POST /api/warmup/mailboxes/[id]/imap/test — verify IMAP credentials.
 *
 * READ-ONLY: connects, authenticates, disconnects. It never lists folders,
 * never fetches a message, never marks anything read, never changes mailbox
 * state. The stored password is decrypted in memory for the connection only.
 *
 * SECURITY: the response contains only a boolean and a short reason. The
 * username and password are never echoed, logged or returned.
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

  const cfg = imapConfigFor(account);
  if (!cfg) {
    return badRequest("This mailbox has no IMAP host configured yet. Set one first.");
  }

  const result = await probeImap(cfg);

  await prisma.smtpAccount.update({
    where: { id },
    data: {
      imapStatus: result.ok ? "connected" : "auth_failed",
      imapLastTestedAt: new Date(),
      imapLastTestError: result.ok ? null : result.message,
    },
  });

  return jsonResponse(
    { ok: result.ok, message: result.message, status: result.ok ? "connected" : "auth_failed" },
    result.ok ? 200 : 400,
  );
}