import { getSession } from "@/lib/auth";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";
import { imapConfigSchema } from "@/lib/warmup/validation";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/warmup/mailboxes/[id]/imap — configure a mailbox's IMAP endpoint.
 *
 * CREDENTIAL HANDLING:
 *   - `imapPassword` is WRITE-ONLY. It is encrypted with AES-256-GCM before it
 *     touches the database and is NEVER included in any response body. Omitting
 *     it preserves whatever is already stored.
 *   - No response from this route ever contains a username, password or any
 *     encrypted blob. The operator can only see whether IMAP is configured.
 *
 * A null `imapHost` clears the IMAP configuration entirely, which puts the
 * mailbox back to "cannot confirm delivery" rather than silently falling back
 * to a stale host.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();
  const { id } = await params;

  const account = await prisma.smtpAccount.findUnique({ where: { id } });
  if (!account || account.userId !== session.sub) return notFound();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = imapConfigSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid IMAP settings");
  }
  const v = parsed.data;

  const data: Record<string, unknown> = {
    imapPort: v.imapPort ?? account.imapPort,
    imapSecurity: v.imapSecurity ?? account.imapSecurity,
    imapStatus: v.imapHost === null ? "unconfigured" : account.imapHost ? account.imapStatus : "unconfigured",
    imapLastTestError: null,
  };

  if (v.imapHost === null) {
    // Clear: no host means no verification. Drop the separate credentials too.
    data.imapHost = null;
    data.imapUsernameEncrypted = null;
    data.imapPasswordEncrypted = null;
  } else if (v.imapHost !== undefined) {
    data.imapHost = v.imapHost;
  }

  if (v.imapUsername !== undefined && v.imapUsername !== null) {
    data.imapUsernameEncrypted = encrypt(v.imapUsername);
  }
  if (v.imapPassword !== undefined && v.imapPassword !== null && v.imapPassword !== "") {
    data.imapPasswordEncrypted = encrypt(v.imapPassword);
  }

  await prisma.smtpAccount.update({ where: { id }, data });
  await prisma.warmupEvent.create({
    data: {
      userId: session.sub,
      mailboxId: account.id,
      type: "imap_configured",
      message: v.imapHost === null ? "IMAP configuration cleared" : "IMAP configuration updated",
    },
  });

  return jsonResponse({
    ok: true,
    imap: {
      configured: Boolean(data.imapHost ?? account.imapHost),
      port: data.imapPort as number,
      security: data.imapSecurity as string,
      // Whether a dedicated IMAP login exists, but NEVER the login or password.
      hasSeparateUsername: Boolean(data.imapUsernameEncrypted ?? account.imapUsernameEncrypted),
      hasSeparatePassword: Boolean(data.imapPasswordEncrypted ?? account.imapPasswordEncrypted),
    },
  });
}

/**
 * GET /api/warmup/mailboxes/[id]/imap — configuration WITHOUT credentials.
 *
 * Present so the UI can prefill host/port/security. The username is reported
 * only as a boolean; the password is never disclosed or even confirmable
 * beyond whether one is stored.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return forbidden();
  const { id } = await params;

  const account = await prisma.smtpAccount.findUnique({ where: { id } });
  if (!account || account.userId !== session.sub) return notFound();

  return jsonResponse({
    imap: {
      configured: Boolean(account.imapHost),
      host: account.imapHost,
      port: account.imapPort,
      security: account.imapSecurity,
      status: account.imapStatus,
      lastTestedAt: account.imapLastTestedAt,
      lastTestError: account.imapLastTestError,
      hasSeparateUsername: Boolean(account.imapUsernameEncrypted),
      hasSeparatePassword: Boolean(account.imapPasswordEncrypted),
      // Decrypted ONLY to prove a credential exists, then discarded. The value
      // itself is deliberately not placed in the response object.
      smtpPasswordPresent: account.passwordEncrypted.length > 0,
    },
  });
}