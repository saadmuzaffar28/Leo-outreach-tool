import { prisma } from "@/lib/prisma";
import { unsubscribeSchema } from "@/lib/validation";
import { verifyUnsubscribe } from "@/lib/suppression";
import { badRequest, jsonResponse } from "@/lib/http";

/**
 * Public one-click unsubscribe. Signature (`s`) must match the one sent in
 * the email footer — this binds the request to the owner + recipient.
 */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const query = form
    ? Object.fromEntries(form.entries())
    : await req.json().catch(() => ({}));

  const parsed = unsubscribeSchema.safeParse(query as Record<string, unknown>);
  if (!parsed.success) return badRequest("Invalid unsubscribe request");

  const { u: userId, e: email, s: signature } = parsed.data;
  if (!verifyUnsubscribe(userId, email, signature)) {
    return badRequest("Invalid unsubscribe signature");
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return jsonResponse({ ok: true });

  await prisma.suppression.upsert({
    where: { userId_email: { userId, email } },
    update: { reason: "unsubscribed via link" },
    create: { userId, email, reason: "unsubscribed via link" },
  });

  return jsonResponse({ ok: true });
}