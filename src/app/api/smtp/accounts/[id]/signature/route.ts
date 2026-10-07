import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { smtpSignatureUpdateSchema } from "@/lib/validation";
import { sanitizeSignatureHtml, SIGNATURE_MAX_LENGTH } from "@/lib/signature";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/smtp/accounts/[id]/signature
 *
 * Updates ONLY the signature fields of a connected SMTP mailbox. It never
 * touches credentials and never re-runs the SMTP connection test (unlike the
 * account PATCH route, which is for host/port/security changes).
 *
 * The rich-text signature is sanitized here, before it is stored, so the value
 * at rest is already safe to render in the app. Storing it in the DB preserves
 * the HTML needed for real email sending.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = smtpSignatureUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid signature payload");
  }

  const { id } = await params;
  const row = await prisma.smtpAccount.findUnique({
    where: { id },
    select: { id: true, userId: true, email: true, signatureEnabled: true, signatureHtml: true },
  });
  if (!row || row.userId !== session.sub) return notFound();

  // Sanitize any newly-supplied HTML before it is ever stored. When the client
  // only toggles the flag, the stored signature is reused as-is.
  let nextHtml: string | null = row.signatureHtml;
  if (parsed.data.signatureHtml !== undefined) {
    const sanitized = sanitizeSignatureHtml(parsed.data.signatureHtml);
    if (sanitized.length > SIGNATURE_MAX_LENGTH) {
      return badRequest(`Signature is too long (max ${SIGNATURE_MAX_LENGTH} characters)`);
    }
    nextHtml = sanitized || null;
  }
  const nextEnabled = parsed.data.signatureEnabled ?? row.signatureEnabled;
  if (nextEnabled && !nextHtml) {
    return badRequest("Write a signature before enabling it");
  }

  const updated = await prisma.smtpAccount.update({
    where: { id },
    data: {
      ...(parsed.data.signatureEnabled !== undefined
        ? { signatureEnabled: parsed.data.signatureEnabled }
        : {}),
      ...(parsed.data.signatureHtml !== undefined ? { signatureHtml: nextHtml } : {}),
    },
    select: { id: true, email: true, signatureEnabled: true, signatureHtml: true },
  });

  return jsonResponse({ ok: true, account: updated });
}