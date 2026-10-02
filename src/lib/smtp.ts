import nodemailer, { type Transporter } from "nodemailer";
import { decrypt, encrypt } from "@/lib/encryption";

/**
 * Generic SMTP / custom-email provider.
 *
 * - Credentials are AES-256-GCM encrypted at rest (see src/lib/encryption.ts).
 * - The password is ONLY ever decrypted in memory, server-side, immediately
 *   before building the nodemailer transporter. It is never written to logs,
 *   never returned by an API, and never shipped into client JS.
 * - Port 465 => implicit TLS (`secure: true`). STARTTLS / plain are explicit
 *   user choices.
 * - We reuse the existing App-OAuth architecture for Google + Microsoft and do
 *   NOT touch it; SMTP is an additional, independent provider.
 */

export type SmtpSecurity = "ssl" | "starttls" | "none";
export interface SmtpAccountInput {
  email: string;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
}

export interface SmtpAccountEncrypted {
  usernameEncrypted: string;
  passwordEncrypted: string;
}

export class SmtpError extends Error {
  readonly code: string          // AUTH_FAILED | TLS_FAILED | CONNECTION_REFUSED | HOST_UNREACHABLE | TEMPORARY | INVALID_CONFIG
  readonly userMessage: string
  constructor(code: string, userMessage: string, cause?: unknown) {
    super(userMessage, cause ? { cause } : undefined);
    this.name = "SmtpError";
    this.code = code;
    this.userMessage = userMessage;
  }
}

/** Encrypt SMTP credentials at rest. Never store the password in plaintext. */
export function encryptSmtpCredentials(input: SmtpAccountInput): SmtpAccountEncrypted {
  // trim username; password is used verbatim (never trimmed, never echoed)
  return {
    usernameEncrypted: encrypt(input.username.trim()),
    passwordEncrypted: encrypt(input.password),
  };
}

/** Decrypt SMTP credentials server-side only, lazily, when building a transporter. */
export function decryptSmtpCredentials(enc: SmtpAccountEncrypted): { username: string; password: string } {
  return {
    username: decrypt(enc.usernameEncrypted),
    password: decrypt(enc.passwordEncrypted),
  };
}

/** A decrypted view of the SMTP account — NEVER serialized, logged, or sent to the client. */
export interface DecryptedSmtpAccount {
  email: string;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
}

/** Classify a thrown nodemailer error into a user-helpful SmtpError. */
export function classifySmtpError(err: unknown): SmtpError {
  const raw = err && typeof err === "object" && "message" in err
    ? String((err as { message: unknown }).message)
    : String(err);
  const code = (err as { code?: string } | undefined)?.code ?? "";
  const lower = raw.toLowerCase();

  if (/eauth|535|5\.7\.8|insecure login|authentication|credentials/i.test(raw)) {
    return new SmtpError("AUTH_FAILED", "SMTP authentication failed. Check the username and password.", err);
  }
  if (/certificate|cert chain|depth_zero|self.signed|unable.to.verify|econstructor|createcipher|invalid protocol|tls|ssl|secure:/i.test(raw) || /SELF_SIGNED_CERT|_CERT_|error:1409/i.test(code)) {
    return new SmtpError("TLS_FAILED", "TLS/SSL negotiation failed. Verify the security mode (SSL vs STARTTLS) and the port.", err);
  }
  if (/econnrefused|531|530|connection refused/i.test(raw)) {
    return new SmtpError("CONNECTION_REFUSED", "SMTP server refused the connection. Check the host, port, and firewall.", err);
  }
  if (/enotfound|eai_again|ehostunreach|getaddrinfo|dns/i.test(raw)) {
    return new SmtpError("HOST_UNREACHABLE", "SMTP host could not be reached. Check the host name and DNS.", err);
  }
  if (/etimedout|esockettimedout|connection timed out/i.test(raw)) {
    return new SmtpError("CONNECTION_REFUSED", "SMTP connection timed out. Check the host and port.", err);
  }

  // Standard 4xx replies are explicitly TRANSIENT by RFC 5321: "the command
  // was not accepted, but retrying later may succeed". This must be checked
  // BEFORE the catch-all below, otherwise a provider saying "421 try again
  // later" gets classified INVALID_CONFIG -- which the warm-up worker (rightly)
  // treats as permanent and would abandon the job instead of backing off and
  // retrying it.
  if (/\b4\d\d\b/.test(raw)) {
    return new SmtpError("TEMPORARY", "SMTP temporarily refused the message (transient). It will be retried.", err);
  }

  // Genuinely unrecognised: a bad host/port/security combination that no amount
  // of retrying will fix.
  //
  // NONE OF THE BRANCHES ABOVE ECHO THE SERVER'S OWN TEXT, and that is
  // deliberate. `message` is stored on campaign recipients, surfaced in the UI,
  // and written into WarmupEvent rows that /api/warmup/events returns -- so an
  // interpolated server string becomes part of an HTTP response and of the
  // database. SMTP servers do quote credentials back (e.g. Postfix:
  // "535 5.7.8 Error: authentication failed: user=user@example.com"), and a
  // hostile or misconfigured relay can put anything there at all.
  //
  // The untouched original is preserved as `cause` for server-side diagnosis.
  return new SmtpError("INVALID_CONFIG", "SMTP connection failed with an unrecognised error. See server logs for detail.", err);
}

/**
 * Build a nodemailer transporter. The password is decrypted here (in memory)
 * and immediately used; it is never captured, logged, or returned.
 */
export function buildTransporter(account: DecryptedSmtpAccount): Transporter {
  const secure = account.security === "ssl";
  const requireTLS = account.security === "starttls";
  const tls = account.security === "none"
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true };
  return nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure,
    requireTLS,
    tls,
    auth: {
      user: account.username,
      pass: account.password,
    },
  });
}

/** Public, safe view for the client. NEVER contains the password (plaintext or
 *  encrypted), NEVER contains the username. */
export interface SmtpAccountView {
  id: string;
  email: string;
  host: string;
  port: number;
  security: SmtpSecurity;
  /**
   * Stored connection state. Written from several places, so this stays a
   * plain string; the values in use are `connected`, `disconnected`,
   * `auth_failed`, `tls_failed` and `config_invalid`.
   *
   * There was a `SmtpConnectionStatus` union exported for these, but nothing
   * ever typed a field with it, so it constrained nothing while looking like
   * it did. It was removed rather than half-wired: see
   * scripts/audit-dead-exports.cjs.
   */
  status: string;
  lastTestedAt: Date | string | null;
  lastTestError: string | null;
  createdAt: Date | string;
}

/** Actually authenticate against the SMTP server using nodemailer's verify(). */
export async function testSmtpConnection(account: DecryptedSmtpAccount): Promise<void> {
  const transporter = buildTransporter(account);
  try {
    await transporter.verify();
  } catch (err) {
    throw classifySmtpError(err);
  } finally {
    transporter.close();
  }
}

/**
 * Strip CR/LF from a header value.
 *
 * RFC 5322 forbids bare CR/LF inside a header field. A value containing one
 * would otherwise be emitted as a real extra header (a `Bcc:` injection, for
 * example). Header names/values here are always internally generated (cuids,
 * RFC 5322 msg-ids), but this is enforced rather than assumed.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** Send one email through the SMTP transporter using the account's own From. */
export async function sendSmtpMail(
  account: DecryptedSmtpAccount,
  msg: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
    /**
     * Extra RFC 5322 headers, as [name, value] pairs. Used by mailbox warm-up to
     * set a deterministic Message-ID and its X-Leo-Warmup-Job correlation header.
     * Campaign sends omit this entirely, so their behaviour is unchanged.
     */
    headers?: Array<[string, string]>;
  }
): Promise<void> {
  const transporter = buildTransporter(account);
  try {
    // nodemailer takes an array of { key, value } for custom headers.
    const extra = (msg.headers ?? []).map(([key, value]) => ({
      key: sanitizeHeaderValue(key),
      value: sanitizeHeaderValue(value),
    }));
    await transporter.sendMail({
      from: `"${account.email.replace(/["\\]/g, "")}" <${account.email}>`,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      replyTo: msg.replyTo,
      ...(extra.length > 0 ? { headers: extra } : {}),
    });
  } catch (err) {
    throw classifySmtpError(err);
  } finally {
    transporter.close();
  }
}
