import { prisma } from "@/lib/prisma";
import { getSession, isOwner } from "@/lib/auth";
import { assertSameOrigin, forbidden, jsonResponse, notFound } from "@/lib/http";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  if (!assertSameOrigin(_req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  const template = await prisma.emailTemplate.findUnique({ where: { id: params.id } });
  if (!template || !isOwner(session, template.userId)) return notFound("Template not found");

  const copy = await prisma.emailTemplate.create({
    data: {
      userId: template.userId,
      name: `${template.name} (copy)`,
      subject: template.subject,
      body: template.body,
      useSignature: template.useSignature,
      signatureOverride: template.signatureOverride,
      isActive: false,
    },
  });

  return jsonResponse({ template: copy }, 201);
}