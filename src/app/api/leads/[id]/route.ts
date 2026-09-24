import { prisma } from "@/lib/prisma";
import { getSession, isOwner } from "@/lib/auth";
import { forbidden, jsonResponse, notFound } from "@/lib/http";

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return forbidden();

  const lead = await prisma.lead.findUnique({ where: { id: params.id } });
  if (!lead || !isOwner(session, lead.userId)) return notFound("Lead not found");
  if (lead.userId !== session.sub) return notFound("Lead not found");

  await prisma.lead.delete({ where: { id: lead.id } });
  return jsonResponse({ ok: true });
}