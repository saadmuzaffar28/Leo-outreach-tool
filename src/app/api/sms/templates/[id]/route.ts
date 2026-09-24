import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { smsTemplateUpdateSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";

async function ownedTemplate(userId: string, id: string) {
  return prisma.smsTemplate.findFirst({ where: { id, userId }, select: { id: true } });
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  const template = await ownedTemplate(session.sub, params.id);
  if (!template) return notFound("Template not found");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = smsTemplateUpdateSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid template");

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.message !== undefined) data.message = parsed.data.message;

  const updated = await prisma.smsTemplate.update({ where: { id: template.id }, data });
  return jsonResponse({ template: updated });
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  const template = await ownedTemplate(session.sub, params.id);
  if (!template) return notFound("Template not found");

  await prisma.smsTemplate.delete({ where: { id: template.id } });
  return jsonResponse({ ok: true });
}
