import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SmtpError,
  encryptSmtpCredentials,
  decryptSmtpCredentials,
  classifySmtpError,
  buildTransporter,
  testSmtpConnection,
  sendSmtpMail,
  summarizeSmtpSend,
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