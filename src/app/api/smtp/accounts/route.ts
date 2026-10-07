import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import {
  classifySmtpError,
  decryptSmtpCredentials,
  describeSmtpFailure,
  encryptSmtpCredentials,
  normalizeDisplayName,
  SmtpError,
  testSmtpConnection,
  type SmtpAccountView,
  type SmtpSecurity,
} from "@/lib/smtp";
import { badRequest, forbidden, jsonResponse, serverError } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Public view of an account row. NEVER contains a password (plaintext or
 *  encrypted). The only identifiers returned are id/email/host/port/security
 *  plus operational status fields. */
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
  signatureEnabled: boolean;
  signatureHtml: string | null;
  displayName: string | null;
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
    signatureEnabled: row.signatureEnabled,
    signatureHtml: row.signatureHtml,
    displayName: row.displayName,
  };
}

/** GET /api/smtp/accounts — list the session user's SMTP accounts (never credentials). */
export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();
  const rows = await prisma.smtpAccount.findMany({
    where: { userId: session.sub },
    orderBy: { createdAt: "desc" },
  });
  return jsonResponse({ accounts: rows.map(toView) });
}

/** POST /api/smtp/accounts — validate + live-test, then persist encrypted-at-rest.
 *  The password is ONLY ever used to (a) live-test and (b) produce AES-256-GCM
 *  ciphertext. It is never stored, returned, logged, or exposed in any view. */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return forbidden();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid JSON body");
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const email = String(b.email ?? "").trim();
  const host = String(b.host ?? "").trim();
  const port = Number(b.port ?? 465);
  const security = (String(b.security ?? "ssl") as SmtpSecurity).trim() as SmtpSecurity;
  const username = String(b.username ?? email).trim();
  const password = String(b.password ?? "");
  // Optional per-mailbox sender name; sanitized (single-line) at the boundary.
  const displayName = normalizeDisplayName(b.displayName == null ? null : String(b.displayName));

  if (!email || !host || !password) {
    return badRequest("email, host and password are required");
  }
  if (!["ssl", "starttls", "none"].includes(security)) {
    return badRequest("security must be one of: ssl, starttls, none");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return badRequest("port must be an integer between 1 and 65535");
  }

  // Live connection test against the REAL mail server BEFORE persisting anything.
  try {
    await testSmtpConnection({ email, username, password, host, port, security });
  } catch (err) {
    const smtpErr = err instanceof SmtpError ? err : classifySmtpError(err);
    // NOTE: nothing is persisted when this branch is taken, so a mailbox that
    // fails here leaves NO row -- which is why a rejected attempt cannot be
    // found by looking at /api/smtp/accounts afterwards. The attempted address
    // is echoed here so the operator can still tell which attempt failed.
    const diag = describeSmtpFailure(smtpErr);
    return jsonResponse(
      { error: smtpErr.userMessage, code: smtpErr.code, email, host, port, security, ...diag },
      400
    );
  }

  const enc = encryptSmtpCredentials({ email, host, port, security, username, password });

  const created = await prisma.smtpAccount.create({
    data: {
      userId: session.sub,
      email,
      host,
      port,
      security,
      usernameEncrypted: enc.usernameEncrypted,
      passwordEncrypted: enc.passwordEncrypted,
      displayName,
      status: "connected",
      lastTestedAt: new Date(),
      lastTestError: null,
    },
  });

  return jsonResponse({ account: toView(created) }, 201);
}
