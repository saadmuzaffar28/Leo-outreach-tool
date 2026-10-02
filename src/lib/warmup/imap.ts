/**
 * IMAP client for warm-up DELIVERY VERIFICATION.
 *
 * WHY THIS EXISTS: a warm-up message being accepted by SMTP proves only that the
 * sending server took it. It does NOT prove the message was delivered, nor
 * anything about inbox placement. Delivery is recorded here ONLY when this
 * module actually observes the message inside the receiving mailbox. Nothing in
 * this file infers delivery from an SMTP acceptance.
 *
 * CREDENTIAL HANDLING: the IMAP password is decrypted in memory immediately
 * before the connection and is never stored on a returned object, logged, or
 * serialized into any API response. `ImapProbe` and `ImapDelivery` expose no
 * credential field at all.
 */

import { ImapFlow } from "imapflow";
import { decrypt } from "@/lib/encryption";
import { parseWarmupHeader, parseMessageIdHeader } from "@/lib/warmup/messages";

export type ImapSecurity = "ssl" | "starttls" | "none";

export interface ImapConnectionConfig {
  host: string;
  port: number;
  security: ImapSecurity;
  username: string;
  password: string;
}

/** A safe, credential-free description of what was verified. */
export interface ImapProbeResult {
  ok: boolean;
  /** Short, user-facing reason. Never contains the username or password. */
  message: string;
}

/** What we learned by actually finding a message in the receiving mailbox. */
export interface ImapDeliveryMatch {
  matched: boolean;
  /** The mailbox-side UID the message was found under, for audit. */
  receiverMessageId: string | null;
  /** True when we found it, false when we connected but saw nothing. */
  confirmed: boolean;
  /** Our own Message-ID as observed in the received message. */
  observedMessageId: string | null;
  latencyMs: number | null;
  message: string;
}

export class ImapError extends Error {
  readonly code: string;
  readonly userMessage: string;
  /** Permanent errors must NOT be retried (bad credentials, bad host). */
  readonly permanent: boolean;

  constructor(code: string, userMessage: string, permanent: boolean, cause?: unknown) {
    super(userMessage, cause ? { cause } : undefined);
    this.name = "ImapError";
    this.code = code;
    this.userMessage = userMessage;
    this.permanent = permanent;
  }
}

/** Classify an IMAP failure into retryable vs permanent. */
export function classifyImapError(err: unknown): ImapError {
  if (err instanceof ImapError) return err;
  const raw = err && typeof err === "object" && "message" in err
    ? String((err as { message: unknown }).message)
    : String(err);
  const responseStatus = (err as { responseStatus?: number } | undefined)?.responseStatus;
  const code = (err as { code?: string } | undefined)?.code ?? "";

  // Authentication / account problems: retrying will never help.
  if (responseStatus === 401 || responseStatus === 403 || /authentication|invalid credentials|login failed|AUTHENTICATIONFAILED/i.test(raw)) {
    return new ImapError("IMAP_AUTH_FAILED", "IMAP authentication failed. Check the IMAP username/password.", true, err);
  }
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|getaddrinfo/i.test(raw) || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new ImapError("IMAP_HOST_UNREACHABLE", "IMAP host could not be reached. Check the host name.", false, err);
  }
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ESOCKET|EPIPE|socket/i.test(raw)) {
    return new ImapError("IMAP_CONNECTION", "IMAP connection failed or timed out.", false, err);
  }
  if (/certificate|self.signed|SSL|TLS|wrong version number/i.test(raw) || /SELF_SIGNED_CERT|_CERT_/i.test(code)) {
    return new ImapError("IMAP_TLS", "IMAP TLS negotiation failed. Check the security mode and port.", true, err);
  }
  // Unrecognised failure. Deliberately NOT the server's own words.
  //
  // Every other branch returns a fixed string for a reason: this message is
  // shown to the operator by the IMAP test route AND persisted to
  // `imapLastTestError`, so anything interpolated from the wire ends up in a
  // browser response and in the database. IMAP servers are known to echo the
  // login in their text -- Dovecot answers
  // `Authentication failed (user=user@example.com)`, and several providers
  // include the full address. Passing that through would disclose a credential
  // to anyone who can open the settings page.
  //
  // The original error is kept as `cause` for server-side diagnosis only; it is
  // never returned or stored.
  return new ImapError("IMAP_ERROR", "IMAP reported an unrecognised error. See server logs for detail.", false, err);
}

function buildClient(cfg: ImapConnectionConfig): ImapFlow {
  // Refuse an empty credential rather than building a client that cannot log in.
  // Without this, a missing username produced an unauthenticated client whose
  // failure mode is a generic "Please configure the login" thrown from deep
  // inside the library before any bytes are sent -- which reads like a server
  // problem and hides a configuration bug. See the auth note below.
  if (!cfg.username || !cfg.password) {
    throw new ImapError(
      "IMAP_AUTH_FAILED",
      "IMAP username or password is missing. Re-save the mailbox IMAP credentials.",
      true,
    );
  }

  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.security === "ssl",
    requireTLS: cfg.security === "starttls",
    tls: cfg.security === "none" ? { rejectUnauthorized: false } : { rejectUnauthorized: true },
    logger: false,
    // Gmail IMAP auth on this host measured 2-12s; be generous but bounded.
    socketTimeout: 60_000,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    // REQUIRED. ImapFlow.connect() throws "Please configure the login" when
    // `auth` is absent, before opening any socket.
    //
    // This was missing, which made the whole IMAP verification feature dead on
    // arrival: `probeImap` could never report success, and `confirmDelivery`
    // could never authenticate, so every warm-up message went `sent` ->
    // `unconfirmed` and nothing was ever recorded as delivered. It survived the
    // whole test suite because every test mocks `probeImap`/`confirmDelivery` at
    // the module boundary, so no test ever constructed a real client.
    // tests/warmup-imap-client.test.ts pins it.
    auth: { user: cfg.username, pass: cfg.password },
  } as ConstructorParameters<typeof ImapFlow>[0]);
}

/**
 * Verify that IMAP credentials work. Connects, authenticates, disconnects.
 * Never lists folders, never reads a message, never marks anything read.
 */
export async function probeImap(cfg: ImapConnectionConfig): Promise<ImapProbeResult> {
  // `buildClient` is inside the try on purpose. It rejects a blank credential,
  // and that rejection has to come back as `{ ok: false, message }` like every
  // other failure -- `probeImap` promises the caller a verdict, never a throw.
  // Constructing the client first would turn a configuration fault into an
  // unhandled exception escaping into the IMAP test route.
  let client: ImapFlow | null = null;
  try {
    client = buildClient(cfg);
    await client.connect();
    return { ok: true, message: "IMAP connection and authentication succeeded." };
  } catch (err) {
    const e = classifyImapError(err);
    return { ok: false, message: e.userMessage };
  } finally {
    if (client) {
      try {
        await client.logout();
      } catch {
        try {
          await client.close();
        } catch {
          /* already closed */
        }
      }
    }
  }
}

/**
 * Look for a warm-up message in the receiving mailbox and confirm its arrival.
 *
 * Searches INBOX (plus a search across the folder for the warm-up header) for
 * the job's Message-ID / X-Leo-Warmup-Job header. Uses UID SEARCH on the
 * header text; does not fetch bodies, does not set \Seen.
 *
 * `sentAt` is when SMTP accepted the message; the returned latency is the
 * observed gap. Returns confirmed=false when the mailbox was reachable but the
 * message was not present yet -- which is NOT a failure, just "not yet".
 */
export async function confirmDelivery(opts: {
  config: ImapConnectionConfig;
  messageId: string;
  jobId: string;
  sentAt: Date;
  /** Give up looking after this long. */
  maxAgeMs?: number;
}): Promise<ImapDeliveryMatch> {
  const { config, messageId, jobId, sentAt } = opts;
  const maxAgeMs = opts.maxAgeMs ?? 30 * 60 * 1000;

  const since = new Date(sentAt.getTime() - 5 * 60 * 1000); // small clock skew slack
  // Inside the try, so a bad config returns an unconfirmed verdict instead of
  // escaping as an exception. See probeImap for the reasoning.
  let client: ImapFlow | null = null;
  try {
    client = buildClient(config);
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Search for the job marker in the raw headers. IMAP SEARCH HEADER is
      // supported by Gmail and virtually every modern IMAP server.
      const uids: number[] = [];
      try {
        const found = await client.search(
          { header: { "X-Leo-Warmup-Job": jobId }, since },
          { uid: true },
        );
        if (Array.isArray(found)) uids.push(...found);
      } catch {
        /* fall through to the Message-ID search below */
      }
      if (uids.length === 0) {
        try {
          const byMsgId = await client.search(
            { header: { "Message-ID": messageId }, since },
            { uid: true },
          );
          if (Array.isArray(byMsgId)) uids.push(...byMsgId);
        } catch {
          /* fall through to the observed=false result */
        }
      }

      if (uids.length === 0) {
        const age = Date.now() - sentAt.getTime();
        return {
          matched: false,
          receiverMessageId: null,
          confirmed: false,
          observedMessageId: null,
          latencyMs: null,
          message:
            age >= maxAgeMs
              ? `Not found in the receiving mailbox after ${Math.round(age / 1000)}s.`
              : "Not yet present in the receiving mailbox.",
        };
      }

      // Newest first; record the UID for audit.
      const uid = uids.sort((a, b) => b - a)[0];
      let observedMessageId: string | null = null;
      try {
        // Fetch ONLY the header block. No body, and never set \Seen.
        const fetched = await client.fetch(uid, { headers: true }, { uid: true });
        const first = Array.isArray(fetched) ? fetched[0] : fetched;
        const raw = first && typeof first === "object" ? (first as { headerLinesText?: string }).headerLinesText : undefined;
        if (typeof raw === "string") {
          observedMessageId = parseMessageIdHeader(raw) ?? parseWarmupHeader(raw);
        }
      } catch {
        /* the UID match above is sufficient evidence of arrival */
      }

      return {
        matched: true,
        receiverMessageId: String(uid),
        confirmed: true,
        observedMessageId,
        latencyMs: Date.now() - sentAt.getTime(),
        message: "Message found in the receiving mailbox.",
      };
    } finally {
      lock.release();
    }
  } catch (err) {
    const e = classifyImapError(err);
    // Surface as a non-confirmed result carrying the reason, so the caller can
    // decide between retrying and pausing without this layer throwing policy.
    return {
      matched: false,
      receiverMessageId: null,
      confirmed: false,
      observedMessageId: null,
      latencyMs: null,
      message: e.userMessage,
    };
  } finally {
    if (client) {
      try {
        await client.logout();
      } catch {
        try {
          await client.close();
        } catch {
          /* already closed */
        }
      }
    }
  }
}

/** Pull an SmtpAccount's IMAP credentials, falling back to its SMTP ones. */
export function imapConfigFor(row: {
  imapHost: string | null;
  imapPort: number;
  imapSecurity: string;
  imapUsernameEncrypted: string | null;
  imapPasswordEncrypted: string | null;
  usernameEncrypted: string;
  passwordEncrypted: string;
}): ImapConnectionConfig | null {
  const host = row.imapHost?.trim();
  if (!host) return null; // no IMAP configured -> verification unavailable
  const usernameEncrypted = row.imapUsernameEncrypted ?? row.usernameEncrypted;
  const passwordEncrypted = row.imapPasswordEncrypted ?? row.passwordEncrypted;
  return {
    host,
    port: row.imapPort,
    security: (row.imapSecurity as ImapSecurity) ?? "ssl",
    // Decrypted here, in memory, and only ever handed to the IMAP client.
    username: decrypt(usernameEncrypted),
    password: decrypt(passwordEncrypted),
  };
}