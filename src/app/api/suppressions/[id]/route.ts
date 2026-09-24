import { prisma } from "@/lib/prisma";
import { getSession, isOwner } from "@/lib/auth";
import { forbidden, jsonResponse, notFound } from "@/lib/http";

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return forbidden();
  const item = await prisma.suppression.findUnique({ where: { id: params.id } });
  if (!item || !isOwner(session, item.userId)) return notFound("Not found");
  await prisma.suppression.delete({ where: { id: item.id } });
  return jsonResponse({ ok: true });
}