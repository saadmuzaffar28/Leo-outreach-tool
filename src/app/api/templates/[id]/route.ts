import { prisma } from "@/lib/prisma";
import { getSession, isOwner } from "@/lib/auth";
import { templateSchema, templateStatusSchema, templateUpdateSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";
import { assertOnlySupportedVariables } from "@/lib/personalization";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return forbidden();
  const template = await prisma.emailTemplate.findUnique({ where: { id: params.id } });
  if (!template || !isOwner(session, template.userId)) return notFound("Template not found");
  return jsonResponse({ template });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  const template = await prisma.emailTemplate.findUnique({ where: { id: params.id } });
  if (!template || !isOwner(session, template.userId)) return notFound("Template not found");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  // Status-only toggle (activate / deactivate).
  if (typeof body === "object" && body !== null && "isActive" in body) {
    const parsed = templateStatusSchema.safeParse(body);
    if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid status");
    const updated = await prisma.emailTemplate.update({
      where: { id: template.id },
      data: { isActive: parsed.data.isActive },
    });
    return jsonResponse({ template: updated });
  }

  const parsed = templateUpdateSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid template");

  const nextSubject = parsed.data.subject ?? template.subject;
  const nextBody = parsed.data.body ?? template.body;
  try {
    assertOnlySupportedVariables(nextSubject + "\n" + nextBody);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  const updated = await prisma.emailTemplate.update({
    where: { id: template.id },
    data: {
      ...parsed.data,
      signatureOverride:
        parsed.data.signatureOverride === undefined
          ? undefined
          : parsed.data.signatureOverride.trim()
            ? parsed.data.signatureOverride
            : null,
    },
  });
  return jsonResponse({ template: updated });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return forbidden();
  const template = await prisma.emailTemplate.findUnique({ where: { id: params.id } });
  if (!template || !isOwner(session, template.userId)) return notFound("Template not found");

  const inUse = await prisma.campaign.count({
    where: { templateId: template.id, status: { not: "completed" } },
  });
  if (inUse > 0) {
    return jsonResponse(
      {
        error:
          "This template is used by a campaign that hasn't finished yet. Stop or complete that campaign first, or switch it to another template.",
      },
      409,
    );
  }

  await prisma.emailTemplate.delete({ where: { id: template.id } });
  return jsonResponse({ ok: true });
}