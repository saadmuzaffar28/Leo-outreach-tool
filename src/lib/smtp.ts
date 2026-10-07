import nodemailer, { type Transporter } from "nodemailer";
import { decrypt, encrypt } from "@/lib/encryption";
import { logSmtpDiagnostic, redactText } from "@/lib/redact";

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
  /** Per-mailbox sender name for the From header; NULL/undefined = local-part fallback. */
  displayName?: string | null;
}

/** Classify a thrown nodemailer error into a user-helpful SmtpError. */
export function classifySmtpError(err: unknown): SmtpError {
  const raw = err && typeof err === "object" && "message" in err
    ? String((err as { message: unknown }).message)
    : String(err);
  const code = (err as { code?: string } | undefined)?.code ?? "";
  const lower = raw.toLowerCase();

  // Authentication failures. A nodemailer `code` of EAUTH always means the
  // server rejected the login, even when its message is terse ("Invalid
  // login."). Google rejects password logins with "534 5.7.14 Please log in
  // via your web browser and then try again." -- a normal Gmail/Workspace
  // account password is never accepted over SMTP, so that reply is an auth
  // failure too, not a configuration mystery, and the message tells the
  // operator exactly what to do (App Password / OAuth2).
  if (
    /eauth/i.test(code) ||
    /eauth|534|535|5\.7\.8|5\.7\.14|insecure login|authentication|credentials/i.test(raw)
  ) {
    const googleBlocked = /5\.7\.14|accounts\.google\.com|signin\/continue/i.test(raw);
    return new SmtpError(
      "AUTH_FAILED",
      googleBlocked
        ? "SMTP authentication failed: the mail server rejected this login. If this is Gmail or Google Workspace, a normal account password is not accepted over SMTP. Enable 2-Step Verification and use a 16-character App Password, or connect this address with OAuth2 instead."
        : "SMTP authentication failed. Check the username and password.",
      err
    );
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
 * Nodemailer's own diagnostic fields, read off the RAW error.
 *
 * `classifySmtpError` throws away everything except a code and a fixed
 * sentence, and that is correct for a message that gets stored and served to
 * the browser -- but it means the interesting parts (the SMTP reply code, the
 * verb that failed, the server's own words) survive ONLY on the preserved
 * `cause`. This pulls them back out for the server-side log.
 *
 * Every field is read defensively: nodemailer is not the only caller, and a
 * thrown value may be a bare string.
 */
function smtpCauseFields(err: unknown): {
  name: string | null;
  code: string | null;
  responseCode: number | null;
  command: string | null;
  message: string;
} {
  const o = (err && typeof err === "object" ? err : {}) as Record<string, unknown>;
  const message = typeof o.message === "string" ? o.message : String(err ?? "");
  return {
    name: typeof o.name === "string" ? o.name : null,
    code: typeof o.code === "string" ? o.code : null,
    responseCode:
      typeof o.responseCode === "number" && Number.isInteger(o.responseCode) ? o.responseCode : null,
    command: typeof o.command === "string" ? o.command : null,
    message,
  };
}

/**
 * The subset of an SMTP failure that is safe to hand back to the operator.
 *
 * `detail` is redacted and capped, so it cannot become the credential-injection
 * channel the classifier comment above is worried about, while still naming the
 * actual server response instead of "an unrecognised error".
 */
export function describeSmtpFailure(err: SmtpError): {
  responseCode: number | null;
  command: string | null;
  detail: string;
} {
  const cause = (err as { cause?: unknown }).cause;
  const f = smtpCauseFields(cause ?? err);
  return {
    responseCode: f.responseCode,
    command: f.command,
    detail: redactText(f.message, 200),
  };
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
   * Per-account email signature. `signatureEnabled` is the opt-in flag; when it
   * is false the account sends without a signature. `signatureHtml` is the
   * sanitized rich-text signature appended to the account's outgoing emails
   * (campaigns, test sends). Stored separate from body/template so retries can
   * never duplicate it, and warm-up messages never carry it.
   */
  signatureEnabled: boolean;
  signatureHtml: string | null;
  /**
   * Per-mailbox sender name (From-header name). NULL means the sending path
   * falls back to the email's local part (`lucas@example.com` -> `Lucas`).
   * Never contains the email address itself: the From ADDRESS always comes
   * from `email`.
   */
  displayName: string | null;
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

/**
 * Strip this account's OWN plaintext secrets out of a diagnostic string.
 *
 * `redactText` matches credential SHAPES (`pass=…`, `password: …`, a bearer
 * token, an `iv:cipher:tag` blob). A shape-based filter cannot see a bare
 * secret sitting in a sentence with no `key=` label -- which is exactly how a
 * password arrives when the server echoes it inside prose.
 *
 * Here the plaintext password is in hand, so it is removed by VALUE rather than
 * by shape. That turns "NEVER log the password" from a probabilistic promise
 * into a guarantee for the one code path that actually holds the secret.
 * Short values are skipped so a 1-3 character password cannot blank out the
 * entire message.
 */
function stripOwnSecrets(text: string, account: { username: string; password: string }): string {
  let out = text;
  for (const secret of [account.password, account.username]) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join("[redacted-credential]");
    }
  }
  return out;
}

/** Actually authenticate against the SMTP server using nodemailer's verify(). */
export async function testSmtpConnection(account: DecryptedSmtpAccount): Promise<void> {
  const transporter = buildTransporter(account);
  try {
    await transporter.verify();
  } catch (err) {
    const classified = classifySmtpError(err);
    // The catch-all branch's message ends "See server logs for detail", and this
    // is the line that keeps that promise. Without it the diagnostic fields
    // existed only on the in-memory `cause` and were unrecoverable once the
    // request ended -- which is why a past failure could not be explained at all.
    const f = smtpCauseFields(err);
    logSmtpDiagnostic({
      email: account.email,
      host: account.host,
      port: account.port,
      security: account.security,
      classifiedAs: classified.code,
      smtpErrorName: f.name,
      smtpErrorCode: f.code,
      responseCode: f.responseCode,
      command: f.command,
      detail: stripOwnSecrets(f.message, account),
    });
    throw classified;
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

/**
 * Normalize a user-supplied sender/display name for storage in the database.
 *
 * Sender names are user-controlled input that ends up inside a From header.
 * Control characters — CR, LF, nuls, and the rest of the C0 set — are collapsed
 * to spaces first (RFC 5322 forbids them in a field body), then the value is
 * trimmed. The actual RFC 2047 quoting/encoding happens later in nodemailer's
 * `{ name, address }` address handling, so nothing here ever needs to hand-build
 * a raw header. Returns null for an empty/whitespace-only value.
 */
export function normalizeDisplayName(value: string | null | undefined): string | null {
  if (value == null) return null;
  const singleLine = value.replace(/[\r\n\x00-\x1f\x7f]+/g, " ").trim();
  return singleLine.length > 0 ? singleLine : null;
}

/**
 * The sender name that goes into `From: "Name" <email>` for an SMTP mailbox.
 *
 * 1. The mailbox's configured `displayName` (sanitized) wins whenever set.
 * 2. Otherwise the address's LOCAL PART is the fallback, with the leading
 *    segment capitalized: `lucas@collabrevsolution.org` -> `Lucas`,
 *    `scott@collabrevsolutions.online` -> `Scott`. Dots/underscores/plus signs
 *    are treated as separators so `scott.brown@x` steers clear of quoting
 *    weirdness and reads like a name.
 *
 * The email ADDRESS itself is never used as the name, and the returned value is
 * always single-line (CR/LF removed) so it can never inject a header.
 */
export function smtpSenderName(account: { displayName?: string | null; email: string }): string {
  const configured = normalizeDisplayName(account.displayName);
  if (configured) return configured;

  const local = (account.email.split("@")[0] ?? "").trim();
  if (local.length === 0) return account.email;

  const firstSegment = local.split(/[._\-+]+/)[0] || local;
  const name = firstSegment.charAt(0).toUpperCase() + firstSegment.slice(1);
  return normalizeDisplayName(name) ?? local;
}

/**
 * What the SMTP server actually said about a message we handed it.
 *
 * nodemailer returns a rich `SentMessageInfo` after a successful DATA
 * transaction. This function used to throw that away and resolve to `void`,
 * which meant that the only durable record of an SMTP send was "it did not
 * throw" — with no identifier to reconcile against server-side logs, and no way
 * to tell a partial acceptance from a full one.
 *
 * `response` is the server's raw final reply. It is returned for in-process
 * diagnosis ONLY and must never be persisted or logged: SMTP servers routinely
 * quote credentials back in their replies (see the note on `classifySmtpError`
 * above). Use {@link summarizeSmtpSend} for anything that is written down.
 */
export interface SmtpSendResult {
  /** RFC 5322 Message-ID assigned by nodemailer, or null if the server gave none. */
  messageId: string | null;
  /** Addresses the server accepted. Empty array means "server said OK, list unknown". */
  accepted: string[];
  /** Addresses the server rejected. Non-empty with a resolved promise is a partial send. */
  rejected: string[];
  /** RAW server reply. In-memory only — never persist, never log. */
  response: string | undefined;
}

/**
 * Reduce an {@link SmtpSendResult} to the subset that is safe to write to the
 * database or a log line: an identifier and two counts.
 *
 * `response` is deliberately excluded. `accepted`/`rejected` are reduced to
 * counts rather than addresses so a log line cannot become a recipient list.
 */
export function summarizeSmtpSend(
  result: SmtpSendResult,
): { messageId: string | null; acceptedCount: number; rejectedCount: number } {
  return {
    messageId: result.messageId,
    acceptedCount: result.accepted.length,
    rejectedCount: result.rejected.length,
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

/**
 * Send one email through the SMTP transporter using the account's own From.
 *
 * Resolves to the server's response metadata. Callers that ignore the result
 * are unaffected — this is purely additive over the previous `Promise<void>`.
 */
export async function sendSmtpMail(
  account: DecryptedSmtpAccount,
  msg: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
    /**
     * Per-mailbox sender name for the From header. When set, the From is built
     * as nodemailer's `{ name, address }` object (which RFC 2047-encodes and
     * quotes the name safely); the ADDRESS is always `account.email`. When
     * absent the historical single-string `"<email>" <email>` form is used
     * verbatim — this is what mailbox warm-up sends, and it is deliberately
     * neutral (no display name), so it must stay byte-for-byte identical.
     */
    fromName?: string;
    /**
     * Extra RFC 5322 headers, as [name, value] pairs. Used by mailbox warm-up to
     * set a deterministic Message-ID and its X-Leo-Warmup-Job correlation header.
     * Campaign sends omit this entirely, so their behaviour is unchanged.
     */
    headers?: Array<[string, string]>;
  }
): Promise<SmtpSendResult> {
  const transporter = buildTransporter(account);
  try {
    // nodemailer takes an array of { key, value } for custom headers.
    const extra = (msg.headers ?? []).map(([key, value]) => ({
      key: sanitizeHeaderValue(key),
      value: sanitizeHeaderValue(value),
    }));
    // The caller's resolved sender name, single-line already (CR/LF stripped in
    // smtpSenderName); nodemailer handles all quoting and RFC 2047 encoding.
    const resolvedName = normalizeDisplayName(msg.fromName ?? undefined);
    const from = resolvedName
      ? { name: resolvedName, address: account.email }
      : `"${account.email.replace(/["\\]/g, "")}" <${account.email}>`;
    const info = await transporter.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      replyTo: msg.replyTo,
      ...(extra.length > 0 ? { headers: extra } : {}),
    });

    return {
      messageId: typeof info?.messageId === "string" ? info.messageId : null,
      accepted: asStringArray(info?.accepted),
      rejected: asStringArray(info?.rejected),
      response: typeof info?.response === "string" ? info.response : undefined,
    };
  } catch (err) {
    throw classifySmtpError(err);
  } finally {
    transporter.close();
  }
}
