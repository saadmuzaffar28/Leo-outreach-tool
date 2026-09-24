import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { smsContactUpdateSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";
import { isValidPhoneNumber, normalizePhoneNumber } from "@/lib/8x8";

async function ownedContact(userId: string, id: string) {
  return prisma.contact.findFirst({ where: { id, userId }, select: { id: true } });
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  const contact = await ownedContact(session.sub, params.id);
  if (!contact) return notFound("Contact not found");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = smsContactUpdateSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid contact");

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.optOut !== undefined) {
    data.optOut = parsed.data.optOut;
    data.status = parsed.data.optOut ? "opted_out" : "active";
  }
  if (parsed.data.phoneNumber !== undefined) {
    const phoneNumber = normalizePhoneNumber(parsed.data.phoneNumber);
    if (!isValidPhoneNumber(phoneNumber)) return badRequest("Invalid phone number");
    const dupe = await prisma.contact.findFirst({
      where: { userId: session.sub, phoneNumber, id: { not: contact.id } },
      select: { id: true },
    });
    if (dupe) return badRequest("Another contact already uses this number");
    data.phoneNumber = phoneNumber;
  }

  const updated = await prisma.contact.update({ where: { id: contact.id }, data });
  return jsonResponse({ contact: updated });
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  const contact = await ownedContact(session.sub, params.id);
  if (!contact) return notFound("Contact not found");

  await prisma.contact.delete({ where: { id: contact.id } });
  return jsonResponse({ ok: true });
}
