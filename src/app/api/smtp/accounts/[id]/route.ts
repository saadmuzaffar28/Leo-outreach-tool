import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import {
  classifySmtpError,
  decryptSmtpCredentials,
  describeSmtpFailure,
  encryptSmtpCredentials,
  SmtpError,
  testSmtpConnection,
  type SmtpAccountView,
  type SmtpSecurity,
} from "@/lib/smtp";
import { badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";

export const dynamic = "force-dynamic";

function toView(row: {
  id: string;
  email: string;
  host: string;
  port: number;
  security: string;
  status: string;
  lastTestedAt: Date | null;
  lastTestError: string | null;
  createdAt: Date;
}): SmtpAccountView {
  return {
    id: row.id,
    email: row.email,
    host: row.host,
    port: row.port,
    security: row.security as SmtpSecurity,
    status: row.status,
    lastTestedAt: row.lastTestedAt,
    lastTestError: row.lastTestError,
    createdAt: row.createdAt,
  };
}

/** GET /api/smtp/accounts/[id] — single account view (no credentials ever). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return forbidden();
  const { id } = await params;

  const row = await prisma.smtpAccount.findUnique({ where: { id } });
  if (!row || row.userId !== session.sub) return notFound();
  return jsonResponse({ account: toView(row) });
}

/** PATCH /api/smtp/accounts/[id] — update + re-test live, then re-encrypt at rest. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return forbidden();
  const { id } = await params;

  const row = await prisma.smtpAccount.findUnique({ where: { id } });
  if (!row || row.userId !== session.sub) return notFound();

  const dec = decryptSmtpCredentials({
    usernameEncrypted: row.usernameEncrypted,
    passwordEncrypted: row.passwordEncrypted,
  });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid JSON body");
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const email = String(b.email ?? row.email).trim();
  const host = String(b.host ?? row.host).trim();
  const port = Number(b.port ?? row.port);
  const security = (String(b.security ?? row.security) as SmtpSecurity).trim() as SmtpSecurity;
  const username = String(b.username ?? dec.username).trim();
  // Password is only updated when the caller supplies a NEW one. The old
  // ciphertext is otherwise preserved so credentials survive a no-op PATCH.
  const password = b.password === undefined ? dec.password : String(b.password);

  if (!email || !host || !password) {
    return badRequest("email, host and password are required");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return badRequest("port must be an integer between 1 and 65535");
  }

  try {
    await testSmtpConnection({ email, username, password, host, port, security });
  } catch (err) {
    const smtpErr = err instanceof SmtpError ? err : classifySmtpError(err);
    const diag = describeSmtpFailure(smtpErr);
    return jsonResponse(
      { error: smtpErr.userMessage, code: smtpErr.code, email, host, port, security, ...diag },
      400
    );
  }

  const enc = encryptSmtpCredentials({ email, host, port, security, username, password });

  const updated = await prisma.smtpAccount.update({
    where: { id },
    data: {
      email,
      host,
      port,
      security,
      usernameEncrypted: enc.usernameEncrypted,
      passwordEncrypted: enc.passwordEncrypted,
      status: "connected",
      lastTestedAt: new Date(),
      lastTestError: null,
    },
  });

  return jsonResponse({ account: toView(updated) });
}

/** DELETE /api/smtp/accounts/[id] — owner-only removal. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return forbidden();
  const { id } = await params;

  const row = await prisma.smtpAccount.findUnique({ where: { id } });
  if (!row || row.userId !== session.sub) return notFound();

  await prisma.smtpAccount.delete({ where: { id } });
  return jsonResponse({ ok: true });
}
