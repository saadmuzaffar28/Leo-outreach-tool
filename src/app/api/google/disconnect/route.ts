import { prisma } from "@/lib/prisma";
import { getSession, isOwner } from "@/lib/auth";
import { assertSameOrigin, forbidden, jsonResponse, notFound } from "@/lib/http";

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

  const account = await prisma.googleAccount.findUnique({ where: { id } });
  if (!account || !isOwner(session, account.userId)) return notFound("Account not found");

  await prisma.$transaction([
    prisma.dailySendCounter.deleteMany({ where: { provider: "google", accountId: id } }),
    prisma.campaign.updateMany({
      where: { googleAccountId: id, status: "active" },
      data: { status: "paused", pausedAt: new Date(), pausedReason: "Sending account disconnected" },
    }),
    prisma.googleAccount.delete({ where: { id } }),
  ]);
  return jsonResponse({ ok: true });
}