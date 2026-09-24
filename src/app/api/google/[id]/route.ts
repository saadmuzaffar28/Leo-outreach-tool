import { prisma } from "@/lib/prisma";
import { getSession, isOwner } from "@/lib/auth";
import { accountSignatureSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  const account = await prisma.googleAccount.findUnique({ where: { id: params.id } });
  if (!account || !isOwner(session, account.userId)) return notFound("Gmail account not found");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = accountSignatureSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid signature");

  const updated = await prisma.googleAccount.update({
    where: { id: account.id },
    data: {
      signatureOverride: parsed.data.signatureOverride.trim() ? parsed.data.signatureOverride : null,
    },
  });

  return jsonResponse({ ok: true, signatureOverride: updated.signatureOverride });
}