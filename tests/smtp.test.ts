import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SmtpError,
  encryptSmtpCredentials,
  decryptSmtpCredentials,
  classifySmtpError,
  describeSmtpFailure,
  buildTransporter,
  testSmtpConnection,
  sendSmtpMail,
  summarizeSmtpSend,
  smtpSenderName,
  normalizeDisplayName,
  type SmtpAccountInput,
  type SmtpAccountView,
  type SmtpSecurity,
  type DecryptedSmtpAccount,
} from "@/lib/smtp";

// Fully-offline: nodemailer's createTransport is mocked so no unit test ever
// opens a socket or sends a real email.
const { createTransportMock, mockTransporter } = vi.hoisted(() => {
  const transporter = {
    options: null as unknown,
    verify: vi.fn(),
    sendMail: vi.fn(),
    close: vi.fn(),
  };
  return {
    mockTransporter: transporter,
    createTransportMock: vi.fn((opts?: unknown) => {
      transporter.options = opts ?? null;
      return transporter;
    }),
  };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: (...args: unknown[]) => createTransportMock(...args) },
}));

const GOOD: SmtpAccountInput = {
  email: "andy@advancedmdmedicalbilling.com",
  host: "advancedmdmedicalbilling.com",
  port: 465,
  security: "ssl" as SmtpSecurity,
  username: "andy@advancedmdmedicalbilling.com",
  password: "sup3r-secret-passw0rd!",
};

const SECRET_PASSWORD = GOOD.password;

function decryptedAccount(): DecryptedSmtpAccount {
  const enc = encryptSmtpCredentials(GOOD);
  return {
    email: GOOD.email,
    host: GOOD.host,
    port: GOOD.port,
    security: GOOD.security,
    ...decryptSmtpCredentials(enc),
  };
}

function viewFromAccount(): SmtpAccountView {
  return {
    id: "c_1",
    email: GOOD.email,
    host: GOOD.host,
    port: GOOD.port,
    security: "ssl" as SmtpSecurity,
    status: "connected",
    lastTestedAt: new Date(),
    lastTestError: null,
    createdAt: new Date(),
    signatureEnabled: false,
    signatureHtml: null,
    displayName: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTransporter.options = null;
});

describe("smtp lib", () => {
  it("encrypts credentials to opaque ciphertext — never plaintext at rest", () => {
    const enc = encryptSmtpCredentials(GOOD);
    const blob = JSON.stringify(enc);
    expect(blob).not.toContain(GOOD.username);
    expect(blob).not.toContain(GOOD.password);
    expect(enc.passwordEncrypted.length).toBeGreaterThan(0);
  });

  it("round-trips credentials through encrypt/decrypt", () => {
    const enc = encryptSmtpCredentials(GOOD);
    const dec = decryptSmtpCredentials(enc);
    expect(dec.username).toBe(GOOD.username);
    expect(dec.password).toBe(GOOD.password);
  });

  it("rejects malformed ciphertext instead of returning partial credentials", () => {
    expect(() =>
      decryptSmtpCredentials({ usernameEncrypted: "junk", passwordEncrypted: "junk" }),
    ).toThrow();
  });

  it("never exposes a password or username in a SmtpAccountView", () => {
    const view = viewFromAccount();
    expect(view).toMatchObject({ email: GOOD.email, host: GOOD.host });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toMatch(/password|passw|secret|username/i);
    expect(serialized).not.toContain(SECRET_PASSWORD);
  });

  describe("classifySmtpError", () => {
    it("classifies authentication failures", () => {
      const err = classifySmtpError(
        Object.assign(new Error("535 5.7.8 Authentication credentials invalid"), {
          code: "EAUTH",
          responseCode: 535,
        })
      );
      expect(err).toBeInstanceOf(SmtpError);
      expect(err.code).toBe("AUTH_FAILED");
    });

    it("classifies Google 534 5.7.14 'please log in via web browser' as AUTH_FAILED and suggests an App Password", () => {
      // Exact shape of the real Gmail reply from the smtp_diagnostic server log:
      //   Invalid login: 534-5.7.14 <https://accounts.google.com/signin/continue?...>
      //   534 5.7.14 Please log in via your web browser and then try again.
      const err = classifySmtpError(
        Object.assign(
          new Error(
            "Invalid login: 534-5.7.14 <https://accounts.google.com/signin/continue?plt=AKgnsbs> " +
              "534 5.7.14 Please log in via your web browser and then try again."
          ),
          { code: "EAUTH", responseCode: 534, command: "AUTH PLAIN" }
        )
      );
      expect(err).toBeInstanceOf(SmtpError);
      expect(err.code).toBe("AUTH_FAILED");
      expect(err.userMessage).toMatch(/App Password/i);
      expect(err.userMessage).toMatch(/2-Step Verification/i);
    });

    it("classifies a bare EAUTH-code failure as AUTH_FAILED with the generic message", () => {
      const err = classifySmtpError(
        Object.assign(new Error("Invalid login."), { code: "EAUTH", responseCode: 535 })
      );
      expect(err.code).toBe("AUTH_FAILED");
      expect(err.userMessage).toContain("Check the username and password");
    });

    it("keeps transient 4xx replies classified as TEMPORARY", () => {
      const err = classifySmtpError(
        Object.assign(new Error("421 4.7.0 Try again later"), { code: "EENVELOPE", responseCode: 421 })
      );
      expect(err.code).toBe("TEMPORARY");
      expect(err.userMessage).toMatch(/transient/i);
    });

    it("classifies TLS/SSL failures", () => {
      const err = classifySmtpError(
        Object.assign(new Error("self signed certificate in certificate chain"), {
          code: "DEPTH_ZERO_SELF_SIGNED_CERT",
        })
      );
      expect(err).toBeInstanceOf(SmtpError);
      expect(err.code).toBe("TLS_FAILED");
    });

    it("classifies connection-refused failures", () => {
      const err = classifySmtpError(
        Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:465"), {
          code: "ECONNREFUSED",
        })
      );
      expect(err).toBeInstanceOf(SmtpError);
      expect(err.code).toBe("CONNECTION_REFUSED");
    });

    it("classifies DNS / host-unreachable failures", () => {
      const err = classifySmtpError(
        Object.assign(new Error("getaddrinfo ENOTFOUND no-such-host.example"), {
          code: "ENOTFOUND",
        })
      );
      expect(err).toBeInstanceOf(SmtpError);
      expect(err.code).toBe("HOST_UNREACHABLE");
    });

    it("classifies timeouts as connection failures", () => {
      const err = classifySmtpError(
        Object.assign(new Error("connect ETIMEDOUT 203.0.113.10:465"), {
          code: "ETIMEDOUT",
        })
      );
      expect(err).toBeInstanceOf(SmtpError);
      expect(err.code).toBe("CONNECTION_REFUSED");
    });

    it("classifies invalid configuration", () => {
      const err = classifySmtpError(new Error("Invalid smtp config"));
      expect(err).toBeInstanceOf(SmtpError);
      expect(err.code).toBe("INVALID_CONFIG");
    });
  });

  describe("buildTransporter", () => {
    it("feeds the decrypted credentials to nodemailer auth — in memory only", () => {
      const account = decryptedAccount();
      const t = buildTransporter(account);
      expect(typeof t.sendMail).toBe("function");
      expect(typeof t.verify).toBe("function");
      expect(t.options).toBeDefined();
      const opts = mockTransporter.options as {
        host: string;
        port: number;
        secure: boolean;
        auth: { user: string; pass: string };
      };
      expect(opts.host).toBe(GOOD.host);
      expect(opts.port).toBe(GOOD.port);
      expect(opts.secure).toBe(true); // port 465 == ssl -> secure
      expect(opts.auth.user).toBe(GOOD.username);
      expect(opts.auth.pass).toBe(SECRET_PASSWORD);
      // The password lives only inside the in-memory transporter; it is not
      // exposed anywhere on the returned view/object.
      expect(JSON.stringify(t.options ?? {})).toContain(SECRET_PASSWORD);
      expect(JSON.stringify(t.options ?? {})).not.toContain("passwordEncrypted");
      t.close();
    });

    it("uses requireTLS for starttls and disables TLS for plain smtp", () => {
      const account = { ...decryptedAccount(), security: "starttls" as SmtpSecurity };
      buildTransporter(account);
      const opts = mockTransporter.options as { secure: boolean; requireTLS: boolean };
      expect(opts.secure).toBe(false);
      expect(opts.requireTLS).toBe(true);

      const plain = { ...decryptedAccount(), security: "none" as SmtpSecurity };
      buildTransporter(plain);
      const plainOpts = mockTransporter.options as { secure: boolean; requireTLS: boolean; tls: { rejectUnauthorized: boolean } };
      expect(plainOpts.secure).toBe(false);
      expect(plainOpts.tls.rejectUnauthorized).toBe(false);
    });
  });

  describe("testSmtpConnection — void-return contract, no real network", () => {
    it("resolves (void) on a successful verify", async () => {
      mockTransporter.verify.mockResolvedValueOnce(true);
      const result = await testSmtpConnection(decryptedAccount());
      expect(result).toBeUndefined();
      expect(mockTransporter.verify).toHaveBeenCalledTimes(1);
    });

    it("throws a typed SmtpError on auth failure", async () => {
      mockTransporter.verify.mockRejectedValueOnce(
        Object.assign(new Error("535 5.7.8 Authentication credentials invalid"), { code: "EAUTH" })
      );
      const err = await testSmtpConnection(decryptedAccount()).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(SmtpError);
      expect((err as SmtpError).code).toBe("AUTH_FAILED");
    });

    it("throws a typed SmtpError on connection-refused", async () => {
      mockTransporter.verify.mockRejectedValueOnce(
        Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:465"), { code: "ECONNREFUSED" })
      );
      const err = await testSmtpConnection(decryptedAccount()).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(SmtpError);
      expect((err as SmtpError).code).toBe("CONNECTION_REFUSED");
    });
  });

  // -------------------------------------------------------------------------
  // Server-side diagnostics.
  //
  // The catch-all branch's message ends "See server logs for detail", and until
  // this was added NOTHING wrote to a server log: a failed connection produced
  // only that generic sentence, so the real cause was unrecoverable. These tests
  // pin both halves of the fix -- that the detail IS emitted, and that emitting
  // it never leaks the credential.
  // -------------------------------------------------------------------------
  describe("SMTP failure diagnostics", () => {
    function captureWarn() {
      const lines: string[] = [];
      const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(" "));
      });
      return { lines, spy, restore: () => spy.mockRestore() };
    }

    function diagnosticsOf(lines: string[]) {
      return lines
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((j): j is Record<string, unknown> => j?.event === "smtp_diagnostic");
    }

    it("emits one diagnostic line per failed verify, carrying the real fields", async () => {
      const cap = captureWarn();
      try {
        mockTransporter.verify.mockRejectedValueOnce(
          Object.assign(new Error("550 5.7.1 Relay access denied"), {
            code: "EENVELOPE",
            responseCode: 550,
            command: "MAIL FROM",
          })
        );
        await testSmtpConnection(decryptedAccount()).then(
          () => {
            throw new Error("expected verify() to reject");
          },
          () => undefined
        );
      } finally {
        cap.restore();
      }

      const entries = diagnosticsOf(cap.lines);
      expect(entries).toHaveLength(1);
      const e = entries[0];

      expect(e.event).toBe("smtp_diagnostic");
      // Required fields, all present and correct.
      expect(typeof e.ts).toBe("string");
      expect(Number.isNaN(Date.parse(String(e.ts)))).toBe(false);
      expect(e.email).toBe(GOOD.email);
      expect(e.host).toBe(GOOD.host);
      expect(e.port).toBe(GOOD.port);
      expect(e.security).toBe(GOOD.security);
      expect(e.smtpErrorName).toBe("Error");
      expect(e.smtpErrorCode).toBe("EENVELOPE");
      expect(e.responseCode).toBe(550);
      // "MAIL FROM" is not a single bare verb, so it is correctly dropped
      // rather than logged as free text.
      expect(e.command).toBeNull();
      // The actual server text -- the thing that was previously lost.
      expect(String(e.detail)).toContain("Relay access denied");
    });

    it("never writes the username, password, or ciphertext into the log", async () => {
      const cap = captureWarn();
      try {
        // A hostile/misconfigured relay that QUOTES THE CREDENTIAL back.
        mockTransporter.verify.mockRejectedValueOnce(
          new Error(`535 5.7.8 Error: authentication failed: user=${GOOD.username} pass=${SECRET_PASSWORD}`)
        );
        await testSmtpConnection(decryptedAccount()).then(
          () => undefined,
          () => undefined
        );
      } finally {
        cap.restore();
      }

      const raw = cap.lines.join("\n");
      expect(raw.length).toBeGreaterThan(0);
      expect(raw).not.toContain(SECRET_PASSWORD);
      // redactText masks the password=... shape and the address in user=...
      expect(raw).toContain("[redacted-credential]");
    });

    it("keeps the credential out even when the error is a bare string", async () => {
      const cap = captureWarn();
      try {
        mockTransporter.verify.mockRejectedValueOnce(`plain string failure with ${SECRET_PASSWORD} in it`);
        await testSmtpConnection(decryptedAccount()).then(
          () => undefined,
          () => undefined
        );
      } finally {
        cap.restore();
      }
      expect(cap.lines.join("\n")).not.toContain(SECRET_PASSWORD);
    });

    it("logs nothing when verify succeeds", async () => {
      const cap = captureWarn();
      try {
        mockTransporter.verify.mockResolvedValueOnce(true);
        await testSmtpConnection(decryptedAccount());
      } finally {
        cap.restore();
      }
      expect(diagnosticsOf(cap.lines)).toHaveLength(0);
    });

    describe("describeSmtpFailure", () => {
      it("recovers the reply code, command, and detail from the preserved cause", () => {
        const cause = Object.assign(new Error("550 5.7.1 Relay access denied"), {
          code: "EENVELOPE",
          responseCode: 550,
          command: "RCPT",
        });
        const err = classifySmtpError(cause);
        // The message is generic on purpose...
        expect(err.userMessage).toMatch(/unrecognised/i);
        // ...but the real detail is still reachable.
        const d = describeSmtpFailure(err);
        expect(d.responseCode).toBe(550);
        expect(d.command).toBe("RCPT");
        expect(d.detail).toContain("Relay access denied");
      });

      it("redacts credentials out of the detail it returns to the caller", () => {
        const cause = new Error(`535 rejected pass=${SECRET_PASSWORD}`);
        const d = describeSmtpFailure(classifySmtpError(cause));
        expect(d.detail).not.toContain(SECRET_PASSWORD);
        expect(d.responseCode).toBeNull();
        expect(d.command).toBeNull();
      });

      it("does not throw when the cause carries a non-numeric responseCode", () => {
        const cause = Object.assign(new Error("odd"), { responseCode: "550" as unknown as number });
        const d = describeSmtpFailure(classifySmtpError(cause));
        expect(d.responseCode).toBeNull();
      });
    });
  });

  describe("sendSmtpMail — mocked transporter", () => {
    it("sends with the account's From and never returns the password", async () => {
      mockTransporter.sendMail.mockResolvedValueOnce({ messageId: "m1" });
      const result = await sendSmtpMail(decryptedAccount(), {
        to: "clinic@example.com",
        subject: "RCM audit",
        html: "<p>hi</p>",
        text: "hi",
      });
      expect(result).toBeDefined();
      expect(result.messageId).toBe("m1");
      expect(JSON.stringify(result)).not.toContain(SECRET_PASSWORD);
      expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);
      const args = mockTransporter.sendMail.mock.calls[0][0] as {
        from: string;
        to: string;
        subject: string;
        html: string;
      };
      expect(args.from).toContain(GOOD.email);
      expect(args.to).toBe("clinic@example.com");
      expect(args.subject).toBe("RCM audit");
      expect(args.html).toBe("<p>hi</p>");
      expect(JSON.stringify(args)).not.toContain(SECRET_PASSWORD);
    });

    it("classifies a failed send as a typed SmtpError", async () => {
      mockTransporter.sendMail.mockRejectedValueOnce(
        Object.assign(new Error("535 5.7.8 Authentication credentials invalid"), { code: "EAUTH" })
      );
      const err = await sendSmtpMail(decryptedAccount(), {
        to: "clinic@example.com",
        subject: "x",
        html: "y",
      }).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(SmtpError);
      expect((err as SmtpError).code).toBe("AUTH_FAILED");
    });

    it("builds From as { name, address } when a sender name is supplied", async () => {
      mockTransporter.sendMail.mockResolvedValueOnce({ messageId: "m2" });
      const account = { ...decryptedAccount(), displayName: "Lucas" };
      await sendSmtpMail(account, {
        to: "clinic@example.com",
        subject: "RCM audit",
        html: "<p>hi</p>",
        fromName: "Lucas",
      });
      const args = mockTransporter.sendMail.mock.calls[0][0] as { from: unknown };
      // nodemailer's Address-object form — the ADDRESS is ALWAYS the sending
      // mailbox; the name can never replace or alter it.
      expect(args.from).toEqual({ name: "Lucas", address: GOOD.email });
    });

    it("keeps the mailbox address when the display name differs from the address", async () => {
      mockTransporter.sendMail.mockResolvedValueOnce({ messageId: "m3" });
      await sendSmtpMail(decryptedAccount(), {
        to: "clinic@example.com",
        subject: "x",
        html: "y",
        fromName: "Scott",
      });
      const args = mockTransporter.sendMail.mock.calls[0][0] as { from: { name: string; address: string } };
      expect(args.from).toEqual({ name: "Scott", address: GOOD.email });
      expect(args.from.address).toBe(GOOD.email);
    });

    it("CR/LF injection in a sender name is neutralised before the From is built", async () => {
      mockTransporter.sendMail.mockResolvedValueOnce({ messageId: "m4" });
      await sendSmtpMail(decryptedAccount(), {
        to: "clinic@example.com",
        subject: "x",
        html: "y",
        // A classic header-injection payload. Must end up as a single-line name.
        fromName: "Lucas\r\nBcc: attacker@example.com\r\nX-Evil: 1",
      });
      const args = mockTransporter.sendMail.mock.calls[0][0] as {
        from: { name: string; address: string };
      };
      expect(args.from.name).toBe("Lucas Bcc: attacker@example.com X-Evil: 1");
      expect(args.from.name).not.toContain("\r");
      expect(args.from.name).not.toContain("\n");
      expect(args.from.address).toBe(GOOD.email);
    });

    it("without a fromName the historical neutral From form is preserved byte-for-byte", async () => {
      mockTransporter.sendMail.mockResolvedValueOnce({ messageId: "m5" });
      await sendSmtpMail(decryptedAccount(), {
        to: "clinic@example.com",
        subject: "x",
        html: "y",
      });
      const args = mockTransporter.sendMail.mock.calls[0][0] as { from: string };
      expect(args.from).toBe(`"${GOOD.email}" <${GOOD.email}>`);
    });
  });

  describe("smtpSenderName — per-mailbox display-name resolution", () => {
    it("Lucas: configured display name wins and the address stays the mailbox", () => {
      expect(smtpSenderName({ displayName: "Lucas", email: "lucas@collabrevsolution.org" })).toBe(
        "Lucas",
      );
    });

    it("Scott: configured display name wins", () => {
      expect(smtpSenderName({ displayName: "Scott", email: "scott@collabrevsolutions.online" })).toBe(
        "Scott",
      );
    });

    it("falls back to the capitalized local part when no name is configured", () => {
      expect(smtpSenderName({ displayName: null, email: "lucas@collabrevsolution.org" })).toBe(
        "Lucas",
      );
      expect(smtpSenderName({ displayName: undefined, email: "scott@collabrevsolutions.online" })).toBe(
        "Scott",
      );
    });

    it("separators in the local part fall back to the leading segment", () => {
      expect(smtpSenderName({ email: "scott.brown@clinic.example" })).toBe("Scott");
      expect(smtpSenderName({ email: "sales_team@clinic.example" })).toBe("Sales");
      expect(smtpSenderName({ email: "info+jobs@clinic.example" })).toBe("Info");
    });

    it("names containing spaces are preserved verbatim", () => {
      expect(smtpSenderName({ displayName: "Lucas Smith", email: "lucas@x.example" })).toBe(
        "Lucas Smith",
      );
    });

    it("a unicode display name passes through (encoding is nodemailer's job)", () => {
      expect(
        smtpSenderName({ displayName: "José García", email: "jose@x.example" }),
      ).toBe("José García");
    });

    it("CR/LF injection attempts collapse to a single-line value", () => {
      expect(
        smtpSenderName({ displayName: "Lucas\r\nBcc: evil@example.com", email: "lucas@x.example" }),
      ).toBe("Lucas Bcc: evil@example.com");
      expect(
        smtpSenderName({ displayName: "Bob\nTheo", email: "bob@x.example" }),
      ).toBe("Bob Theo");
    });

    it("an empty/whitespace-only configured name behaves like NULL", () => {
      expect(smtpSenderName({ displayName: "   ", email: "lucas@collabrevsolution.org" })).toBe(
        "Lucas",
      );
    });
  });

  describe("normalizeDisplayName — stored-value sanitisation", () => {
    it("returns null for null/undefined/empty", () => {
      expect(normalizeDisplayName(null)).toBeNull();
      expect(normalizeDisplayName(undefined)).toBeNull();
      expect(normalizeDisplayName("")).toBeNull();
      expect(normalizeDisplayName("  \t ")).toBeNull();
    });

    it("collapses control characters to spaces and trims", () => {
      expect(normalizeDisplayName("  Lucas\nSmith  ")).toBe("Lucas Smith");
      expect(normalizeDisplayName("a\u0000b")).toBe("a b");
      expect(normalizeDisplayName("a\r\nb")).toBe("a b");
    });
  });

  /**
   * The provider's reply was previously discarded, so the only durable record
   * of an SMTP send was "it did not throw". These lock in that the metadata is
   * now captured — and, just as importantly, that the unsafe parts of it are
   * not smuggled into the persistence helper.
   */
  describe("sendSmtpMail — provider response metadata", () => {
    const msg = { to: "clinic@example.com", subject: "x", html: "y" };

    it("returns the Message-ID, accepted and rejected lists", async () => {
      mockTransporter.sendMail.mockResolvedValueOnce({
        messageId: "<abc123@mail.example.com>",
        accepted: ["clinic@example.com"],
        rejected: [],
        response: "250 2.0.0 Ok: queued as 4A2B3C",
      });
      const result = await sendSmtpMail(decryptedAccount(), msg);
      expect(result.messageId).toBe("<abc123@mail.example.com>");
      expect(result.accepted).toEqual(["clinic@example.com"]);
      expect(result.rejected).toEqual([]);
      expect(result.response).toBe("250 2.0.0 Ok: queued as 4A2B3C");
    });

    it("surfaces a PARTIAL acceptance, which a bare 'did not throw' would hide", async () => {
      mockTransporter.sendMail.mockResolvedValueOnce({
        messageId: "<partial@mail.example.com>",
        accepted: ["good@example.com"],
        rejected: ["bad@example.com"],
        response: "250 2.0.0 Ok",
      });
      const result = await sendSmtpMail(decryptedAccount(), msg);
      expect(result.accepted).toHaveLength(1);
      expect(result.rejected).toEqual(["bad@example.com"]);
    });

    it("tolerates a server that reports nothing at all", async () => {
      mockTransporter.sendMail.mockResolvedValueOnce({});
      const result = await sendSmtpMail(decryptedAccount(), msg);
      expect(result).toEqual({
        messageId: null,
        accepted: [],
        rejected: [],
        response: undefined,
      });
    });

    it("still closes the transporter on the success path", async () => {
      mockTransporter.sendMail.mockResolvedValueOnce({ messageId: "m" });
      await sendSmtpMail(decryptedAccount(), msg);
      expect(mockTransporter.close).toHaveBeenCalled();
    });
  });

  describe("summarizeSmtpSend", () => {
    it("keeps the Message-ID but drops the raw response", () => {
      const summary = summarizeSmtpSend({
        messageId: "<keep@mail.example.com>",
        accepted: ["a@example.com", "b@example.com"],
        rejected: ["c@example.com"],
        response: "250 2.0.0 Ok: queued as X user=user@example.com password=hunter2",
      });
      expect(summary).toEqual({
        messageId: "<keep@mail.example.com>",
        acceptedCount: 2,
        rejectedCount: 1,
      });
      // The raw reply is the credential-leak vector: it must not survive.
      expect(JSON.stringify(summary)).not.toContain("hunter2");
      expect(JSON.stringify(summary)).not.toContain("user@example.com");
    });

    it("reduces addresses to counts so a log line cannot become a recipient list", () => {
      const summary = summarizeSmtpSend({
        messageId: null,
        accepted: ["one@example.com"],
        rejected: [],
        response: undefined,
      });
      expect(JSON.stringify(summary)).not.toContain("one@example.com");
    });
  });
});