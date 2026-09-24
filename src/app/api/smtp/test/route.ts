import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import {
  classifySmtpError,
  decryptSmtpCredentials,
  SmtpError,
  testSmtpConnection,
  type SmtpSecurity,
} from "@/lib/smtp";
import { badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/smtp/test — run a live SMTP connection test for an existing stored
 *  account (server-side decryption only). Never exposes credentials: the SMTP
 *  library's classified userMessage/code are returned, the password is never
 *  included in any output and never logged. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return forbidden();

  let accountId: string;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("invalid JSON body");
    }
    accountId = String((body as Record<string, unknown>)?.accountId ?? "").trim();
  } catch {
    return badRequest("accountId is required");
  }
  if (!accountId) return badRequest("accountId is required");

  const row = await prisma.smtpAccount.findUnique({ where: { id: accountId } });
  if (!row || row.userId !== session.sub) return notFound();

  const dec = decryptSmtpCredentials({
    usernameEncrypted: row.usernameEncrypted,
    passwordEncrypted: row.passwordEncrypted,
  });

  try {
    await testSmtpConnection({
      email: row.email,
      username: dec.username,
      password: dec.password,
      host: row.host,
      port: row.port,
      security: row.security as SmtpSecurity,
    });

    await prisma.smtpAccount.update({
      where: { id: accountId },
      data: { status: "connected", lastTestedAt: new Date(), lastTestError: null },
    });
    return jsonResponse({ ok: true, status: "connected" });
  } catch (err) {
    const smtpErr = err instanceof SmtpError ? err : classifySmtpError(err);

    await prisma.smtpAccount.update({
      where: { id: accountId },
      data: {
        status: "error",
        lastTestedAt: new Date(),
        lastTestError: smtpErr.userMessage,
      },
    });
    return jsonResponse(
      { ok: false, status: "error", error: smtpErr.userMessage, code: smtpErr.code },
      400
    );
  }
}
