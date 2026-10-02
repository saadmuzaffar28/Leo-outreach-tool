import { describe, it, expect } from "vitest";
import {
  buildWarmupMessageId,
  buildWarmupContent,
  buildWarmupHeaders,
  warmupNonce,
  parseWarmupHeader,
  parseMessageIdHeader,
  WARMUP_HEADER,
} from "@/lib/warmup/messages";
import { sanitizeHeaderValue } from "@/lib/smtp";

describe("warm-up content is neutral and internal", () => {
  it("cycles a small fixed set of subjects", () => {
    const a = buildWarmupContent(0, "job1").subject;
    const b = buildWarmupContent(3, "job1").subject;
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("never contains merge variables or prospect placeholders", () => {
    for (let i = 0; i < 10; i++) {
      const { subject, text, body } = buildWarmupContent(i, "job1");
      for (const s of [subject, text, body]) {
        expect(s).not.toMatch(/\{\{.*\}\}/);
        expect(s).not.toMatch(/first_name|last_name|practice_name/i);
      }
    }
  });

  it("carries no campaign-style marketing language", () => {
    for (let i = 0; i < 10; i++) {
      const { subject } = buildWarmupContent(i, "job1");
      expect(subject.toLowerCase()).not.toMatch(/invoice|claims|denied|billing|practice|records request/i);
    }
  });

  it("varies content across sends so messages are not byte-identical", () => {
    const bodies = new Set<string>();
    for (let i = 0; i < 10; i++) bodies.add(buildWarmupContent(i, "job1").body);
    expect(bodies.size).toBeGreaterThan(1);
  });
});

describe("warm-up headers", () => {
  const headers = buildWarmupHeaders({
    jobId: "cmul1234abcd",
    messageId: "<warmup-cmul1234abcd@alpha.example>",
    from: "a@alpha.example",
    to: "b@beta.example",
    subject: "Internal delivery check",
    nonce: warmupNonce(),
  });

  it("includes the correlation header and a Message-ID", () => {
    const keys = headers.map(([k]) => k);
    expect(keys).toContain(WARMUP_HEADER);
    expect(keys).toContain("Message-ID");
  });

  it("never contains credentials or tokens", () => {
    const flat = JSON.stringify(headers).toLowerCase();
    for (const secret of ["password", "passwd", "token", "secret", "bearer", "apikey", "api_key", "credential", "oauth", "refresh"]) {
      expect(flat).not.toContain(secret);
    }
  });

  it("marks the message as auto-generated so replies are not expected", () => {
    const m = new Map(headers);
    expect(m.get("Auto-Submitted")).toBe("auto-generated");
    expect(m.get("Precedence")).toBe("bulk");
  });

  it("emits no value containing a bare CR or LF", () => {
    for (const [, value] of headers) {
      expect(value).not.toMatch(/[\r\n]/);
    }
  });
});

describe("message id", () => {
  it("is deterministic for a job so IMAP can match it", () => {
    expect(buildWarmupMessageId("job1", "alpha.example")).toBe(buildWarmupMessageId("job1", "alpha.example"));
  });

  it("differs per job", () => {
    expect(buildWarmupMessageId("job1", "alpha.example")).not.toBe(buildWarmupMessageId("job2", "alpha.example"));
  });

  it("strips unsafe characters from the domain", () => {
    expect(buildWarmupMessageId("job1", "bad domain\r\nX-Injected: y")).toBe("<warmup-job1@baddomainX-Injectedy>");
  });

  it("falls back to localhost for an empty domain", () => {
    expect(buildWarmupMessageId("job1", "")).toBe("<warmup-job1@localhost>");
  });
});

describe("IMAP header parsing", () => {
  it("reads the correlation header case-insensitively", () => {
    const raw = "Subject: hi\r\nx-leo-warmup-job: cmul1234abcd\r\nTo: a@b.c";
    expect(parseWarmupHeader(raw)).toBe("cmul1234abcd");
  });

  it("returns null when the header is absent", () => {
    expect(parseWarmupHeader("Subject: hi\r\nTo: a@b.c")).toBeNull();
  });

  it("rejects a hostile header value instead of trusting it", () => {
    // Spaces, quotes, angle brackets and SQL-ish characters are all refused:
    // nothing outside the safe charset is ever returned.
    for (const bad of [
      "cmul1234abcd OR 1=1",
      '"cmul1234abcd"',
      "<cmul1234abcd>",
      "abc",
      "'; DROP TABLE \"WarmupJob\"; --",
      "cmul1234abcd; DROP TABLE x",
    ]) {
      expect(parseWarmupHeader(`${WARMUP_HEADER}: ${bad}`)).toBeNull();
    }
  });

  it("can never return a value carrying CR/LF, even with smuggled headers", () => {
    // Parsing is line-by-line, so a smuggled continuation is seen as a separate
    // header. Whatever comes back must still be a single safe token.
    for (const smuggled of [
      "cmul1234abcd\r\nBcc: x@y.example",
      "cmul1234abcd\nBcc: x@y.example",
      "cmul1234abcd\rBcc: x@y.example",
    ]) {
      const out = parseWarmupHeader(`${WARMUP_HEADER}: ${smuggled}`);
      if (out !== null) {
        expect(out).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
        expect(out).not.toMatch(/[\r\n]/);
      }
      // The smuggled Bcc must never be mistaken for our marker header.
      expect(parseWarmupHeader(`Bcc: ${smuggled}`)).toBeNull();
    }
  });

  it("accepts a normal cuid-shaped value", () => {
    expect(parseWarmupHeader(`${WARMUP_HEADER}: cmulmq0xx012fid2kb1gjn9hf`)).toBe("cmulmq0xx012fid2kb1gjn9hf");
  });

  it("reads a Message-ID", () => {
    expect(parseMessageIdHeader("Message-ID: <warmup-j1@x.example>\r\nSubject: s")).toBe("<warmup-j1@x.example>");
  });
});

describe("header sanitisation on the SMTP path", () => {
  it("collapses CR/LF so one header cannot become two", () => {
    expect(sanitizeHeaderValue("Acme\r\nBcc: x@y.example")).toBe("Acme Bcc: x@y.example");
  });

  it("leaves a clean value untouched", () => {
    expect(sanitizeHeaderValue("<warmup-j1@x.example>")).toBe("<warmup-j1@x.example>");
  });
});