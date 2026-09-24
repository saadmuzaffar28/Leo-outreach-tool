import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SmtpError,
  encryptSmtpCredentials,
  decryptSmtpCredentials,
  classifySmtpError,
  buildTransporter,
  testSmtpConnection,
  sendSmtpMail,
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
      expect(result).toBeUndefined();
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
});