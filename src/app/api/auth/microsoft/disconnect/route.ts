import { prisma } from "@/lib/prisma";
import { getSession, isOwner } from "@/lib/auth";
import { assertSameOrigin, forbidden, jsonResponse, notFound } from "@/lib/http";

// Disconnects an Outlook (Microsoft Graph) account. Deletes the stored OAuth
// tokens and its daily counters; campaigns revert to having no sender and any
// active ones are paused so the worker never sends as an unlinked account.
export async function POST(req: Request) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const id = (body as { id?: string })?.id;
  if (!id) return jsonResponse({ error: "Missing account id" }, 400);

  const account = await prisma.microsoftAccount.findUnique({ where: { id } });
  if (!account || !isOwner(session, account.userId)) return notFound("Account not found");

  await prisma.$transaction([
    prisma.dailySendCounter.deleteMany({ where: { provider: "microsoft", accountId: id } }),
    prisma.campaign.updateMany({
      where: { microsoftAccountId: id, status: "active" },
      data: { status: "paused", pausedAt: new Date(), pausedReason: "Sending account disconnected" },
    }),
    prisma.microsoftAccount.delete({ where: { id } }),
  ]);

  return jsonResponse({ ok: true });
}