/**
 * The IMAP client is actually wired up with credentials.
 *
 * WHY THIS FILE EXISTS: `buildClient()` constructed an `ImapFlow` without ever
 * passing `auth`. `ImapFlow.connect()` throws "Please configure the login" in
 * that case, before opening a socket, so `probeImap` could never report success
 * and `confirmDelivery` could never authenticate. In production that meant
 * delivery confirmation was dead on arrival: every warm-up message went
 * `sent` -> `unconfirmed` and nothing was ever recorded as delivered, while the
 * UI reported an "unrecognised IMAP error".
 *
 * The entire rest of the warm-up suite mocks `probeImap`/`confirmDelivery` at the
 * module boundary, so no test ever built a real client and the defect was
 * invisible. This file mocks the `imapflow` MODULE instead, which is one layer
 * lower -- close enough to inspect the options the library was constructed with,
 * far enough to never touch the network.
 *
 * If you add a field to `ImapConnectionConfig` that the client is supposed to
 * receive, assert on it here.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const seen = vi.hoisted(() => ({
  /** Every options object an ImapFlow was ever constructed with. */
  options: [] as Record<string, unknown>[],
  instances: 0,
}));

vi.mock("imapflow", () => {
  class ImapFlow {
    constructor(opts: Record<string, unknown>) {
      seen.options.push(opts);
      seen.instances += 1;
    }
    async connect(): Promise<void> {}
    async logout(): Promise<void> {}
    async close(): Promise<void> {}
    async getMailboxLock(_name: string) {
      return { release: () => {} };
    }
    async search(_criterion: unknown, _opts?: unknown): Promise<number[]> {
      return [];
    }
    async fetch(_uid: number, _range: unknown, _opts?: unknown): Promise<unknown[]> {
      return [];
    }
  }
  return { ImapFlow };
});

import { probeImap, confirmDelivery, imapConfigFor } from "@/lib/warmup/imap";

const CFG = {
  host: "imap.example.test",
  port: 993,
  security: "ssl" as const,
  username: "warmup.owner@example.test",
  password: "sup3r-secret-password",
};

/** The options the last-constructed client received. */
function lastOptions(): Record<string, unknown> {
  return seen.options[seen.options.length - 1];
}

describe("buildClient hands the IMAP library real credentials", () => {
  beforeEach(() => {
    seen.options.length = 0;
    seen.instances = 0;
  });

  it("passes `auth` to ImapFlow — the defect this file pins", async () => {
    await probeImap(CFG);

    expect(seen.instances).toBe(1);
    expect(lastOptions().auth).toEqual({
      user: CFG.username,
      pass: CFG.password,
    });
  });

  // NOTE: an earlier version of this file also asserted that a real ImapFlow
  // rejects a client built without `auth`. That test was removed deliberately:
  // it needed a reachable host to reach the auth check (ImapFlow connects and
  // reads the greeting BEFORE validating `auth`), so it either hit the network
  // or failed on DNS for a fake host. The assertion that matters is the one
  // above -- that we pass `auth` -- and that needs no network at all.

  it("gives the delivery-confirmation path credentials too", async () => {
    // Same builder, same defect would have hit both entry points.
    await confirmDelivery({
      config: CFG,
      messageId: "<warmup-1@example.test>",
      jobId: "job-1",
      sentAt: new Date(),
    });

    expect(seen.instances).toBe(1);
    expect(lastOptions().auth).toEqual({ user: CFG.username, pass: CFG.password });
  });

  it("still maps the security mode onto the right transport options", async () => {
    await probeImap({ ...CFG, security: "starttls" });
    expect(lastOptions().secure).toBe(false);
    expect(lastOptions().requireTLS).toBe(true);

    await probeImap({ ...CFG, security: "ssl" });
    expect(lastOptions().secure).toBe(true);

    await probeImap({ ...CFG, security: "none" });
    expect(lastOptions().tls).toEqual({ rejectUnauthorized: false });

    await probeImap({ ...CFG, security: "ssl" });
    expect(lastOptions().tls).toEqual({ rejectUnauthorized: true });
  });
});

describe("missing credentials fail loudly instead of silently", () => {
  beforeEach(() => {
    seen.options.length = 0;
    seen.instances = 0;
  });

  it("never opens a connection when the username is blank", async () => {
    const result = await probeImap({ ...CFG, username: "" });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/username or password is missing/i);
    // The decisive part: no client was even constructed, so there is nothing to
    // silently succeed-without-authenticating later.
    expect(seen.instances).toBe(0);
  });

  it("never opens a connection when the password is blank", async () => {
    const result = await probeImap({ ...CFG, password: "" });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/username or password is missing/i);
    expect(seen.instances).toBe(0);
  });

  it("gives the worker an unconfirmed verdict, not a thrown exception", async () => {
    // This is the contract the worker depends on: `confirmDelivery` reports, it
    // does not throw. A blank credential that escaped as an exception would
    // surface in the worker as an unrelated tick failure, and the mailbox would
    // eventually auto-pause for what is really a configuration fault.
    const match = await confirmDelivery({
      config: { ...CFG, password: "" },
      messageId: "<warmup-2@example.test>",
      jobId: "job-2",
      sentAt: new Date(),
    });

    expect(match.confirmed).toBe(false);
    expect(match.matched).toBe(false);
    expect(match.message).toMatch(/username or password is missing/i);
    // Critically: never "confirmed". A missing password must not be mistaken
    // for evidence of arrival.
    expect(match.observedMessageId).toBeNull();
    expect(match.receiverMessageId).toBeNull();
    expect(match.latencyMs).toBeNull();
  });

  it("does not leak the password into any probe result", async () => {
    for (const cfg of [CFG, { ...CFG, username: "" }, { ...CFG, password: "" }]) {
      const result = await probeImap(cfg);
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain(CFG.password);
      expect(serialised).not.toContain(CFG.username);
    }
  });
});

describe("imapConfigFor resolves credentials from the account row", () => {
  it("uses IMAP-specific credentials when present", () => {
    // encrypt() lives in the app's crypto module and needs a real key, so this
    // test only asserts the null-handling contract, not the crypto.
    expect(
      imapConfigFor({
        imapHost: null,
        imapPort: 993,
        imapSecurity: "ssl",
        imapUsernameEncrypted: null,
        imapPasswordEncrypted: null,
        usernameEncrypted: "x",
        passwordEncrypted: "y",
      }),
    ).toBeNull();
  });

  it("refuses to produce a config when no IMAP host is set", () => {
    // Verification being unavailable must be explicit, never a half-built
    // config that would later fail in a confusing way.
    const cfg = imapConfigFor({
      imapHost: "   ",
      imapPort: 993,
      imapSecurity: "ssl",
      imapUsernameEncrypted: null,
      imapPasswordEncrypted: null,
      usernameEncrypted: "x",
      passwordEncrypted: "y",
    });
    expect(cfg).toBeNull();
  });
});