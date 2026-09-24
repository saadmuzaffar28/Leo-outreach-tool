import {
  X8ApiError,
  type X8SendSmsRequest,
  type X8SendSmsResponse,
  type X8SendBatchRequest,
  type X8SendBatchResponse,
} from "./types";

/**
 * Server-side 8x8 Connect HTTP client.
 *
 * Credentials come exclusively from environment variables (X8_API_KEY,
 * X8_SUBACCOUNT_ID) and are never logged or exposed to the browser.
 * Docs: https://developer.8x8.com/connect/reference/sms-api/
 */
export class X8Client {
  private readonly apiKey: string;
  private readonly subAccountId: string;
  private readonly baseUrl: string;

  constructor(opts?: { apiKey?: string; subAccountId?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.X8_API_KEY ?? "";
    this.subAccountId = opts?.subAccountId ?? process.env.X8_SUBACCOUNT_ID ?? "";
    this.baseUrl = (opts?.baseUrl ?? "https://sms.8x8.com").replace(/\/+$/, "");
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0 && this.subAccountId.length > 0;
  }

  private assertConfigured(): void {
    if (!this.isConfigured) {
      throw new X8ApiError(
        "8x8 is not configured. Set X8_API_KEY and X8_SUBACCOUNT_ID environment variables.",
      );
    }
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    this.assertConfigured();
    const url = `${this.baseUrl}/api/v1/subaccounts/${encodeURIComponent(this.subAccountId)}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      // Network/DNS/timeout — never include the API key in error output.
      throw new X8ApiError(
        `Failed to reach 8x8 API: ${err instanceof Error ? err.message : "network error"}`,
      );
    }

    const text = await res.text();
    if (!res.ok) {
      let code: string | number | undefined;
      try {
        const parsed = JSON.parse(text) as { errorCode?: string | number; message?: string };
        code = parsed.errorCode;
      } catch {
        /* non-JSON body */
      }
      throw new X8ApiError(`8x8 API returned ${res.status}`, {
        statusCode: res.status,
        apiErrorCode: code,
        responseBody: text.slice(0, 2_000),
      });
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new X8ApiError("8x8 API returned a non-JSON response", {
        statusCode: res.status,
        responseBody: text.slice(0, 2_000),
      });
    }
  }

  /** Send one SMS. Returns the 8x8 umid on success. */
  async sendSms(req: X8SendSmsRequest): Promise<X8SendSmsResponse> {
    return this.request<X8SendSmsResponse>("/messages", req);
  }

  /** Send up to 10,000 SMS with shared or personalized content. */
  async sendBatch(req: X8SendBatchRequest): Promise<X8SendBatchResponse> {
    return this.request<X8SendBatchResponse>("/messages/batch", req);
  }
}

/** Shared singleton for server-side use. */
export const x8Client = new X8Client();

export function getX8Client(): X8Client {
  return x8Client;
}

/** True when real 8x8 credentials are present in the environment. */
export function isX8Configured(): boolean {
  return x8Client.isConfigured;
}
