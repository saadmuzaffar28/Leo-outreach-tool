import { describe, it, expect, vi, afterEach } from "vitest";
import { X8Client } from "@/lib/8x8/client";
import { X8ApiError } from "@/lib/8x8/types";

const CONFIG = { apiKey: "test-api-key-123", subAccountId: "test_subaccount" };

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue(
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("X8Client configuration", () => {
  it("reports unconfigured when key or subaccount missing", () => {
    expect(new X8Client({ apiKey: "", subAccountId: "" }).isConfigured).toBe(false);
    expect(new X8Client({ apiKey: "k", subAccountId: "" }).isConfigured).toBe(false);
    expect(new X8Client({ apiKey: "", subAccountId: "s" }).isConfigured).toBe(false);
    expect(new X8Client(CONFIG).isConfigured).toBe(true);
  });

  it("rejects sends when not configured (missing API key)", async () => {
    const client = new X8Client({ apiKey: "", subAccountId: "" });
    await expect(
      client.sendSms({ destination: "+12025550123", source: "Test", text: "hi" }),
    ).rejects.toThrow(/not configured/i);
  });
});

describe("X8Client.sendSms", () => {
  it("sends bearer auth and posts to the documented endpoint", async () => {
    const fetchMock = mockFetchOnce(200, {
      umid: "abc-123",
      destination: "+12025550123",
      status: { code: "QUEUED", description: "SMS is accepted and queued for processing" },
    });
    const client = new X8Client(CONFIG);
    const res = await client.sendSms({ destination: "+12025550123", source: "StarBill", text: "Hello" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sms.8x8.com/api/v1/subaccounts/test_subaccount/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-api-key-123");
    const body = JSON.parse(String(init.body));
    expect(body.destination).toBe("+12025550123");
    expect(body.text).toBe("Hello");
    expect(res.umid).toBe("abc-123");
    expect(res.status.code).toBe("QUEUED");
  });

  it("throws X8ApiError on invalid API key (401)", async () => {
    mockFetchOnce(401, { errorCode: "UNAUTHORIZED", message: "Request was not authenticated" });
    const client = new X8Client(CONFIG);
    await expect(
      client.sendSms({ destination: "+12025550123", source: "x", text: "hi" }),
    ).rejects.toMatchObject({
      name: "X8ApiError",
      statusCode: 401,
    } satisfies Partial<X8ApiError>);
  });

  it("throws X8ApiError on 8x8 server failure (500)", async () => {
    mockFetchOnce(500, "Internal server error");
    const client = new X8Client(CONFIG);
    await expect(client.sendSms({ destination: "+1", source: "x", text: "hi" })).rejects.toBeInstanceOf(
      X8ApiError,
    );
  });

  it("never leaks the API key in network error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    );
    const client = new X8Client(CONFIG);
    try {
      await client.sendSms({ destination: "+12025550123", source: "x", text: "hi" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(X8ApiError);
      expect((err as Error).message).not.toContain("test-api-key-123");
    }
  });
});

describe("X8Client.sendBatch", () => {
  it("posts personalized destinations to the batch endpoint", async () => {
    const fetchMock = mockFetchOnce(200, {
      batchId: "batch-1",
      acceptedCount: 2,
      rejectedCount: 0,
      messages: [
        { umid: "u1", clientMessageId: "m1", destination: "+12025550123" },
        { umid: "u2", clientMessageId: "m2", destination: "+12025550124" },
      ],
      status: { code: "QUEUED", description: "ok" },
    });
    const client = new X8Client(CONFIG);
    const res = await client.sendBatch({
      source: "StarBill",
      destinations: [
        { destination: "+12025550123", text: "Hi Jane", clientMessageId: "m1" },
        { destination: "+12025550124", text: "Hi John", clientMessageId: "m2" },
      ],
      includeMessagesInResponse: true,
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith("/messages/batch")).toBe(true);
    expect(res.batchId).toBe("batch-1");
    expect(res.acceptedCount).toBe(2);
    expect(res.messages?.length).toBe(2);
  });
});
