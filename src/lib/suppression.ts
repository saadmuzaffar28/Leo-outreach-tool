import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

const signKey = (): Buffer => createHmac("sha256", env.SESSION_SECRET).digest();

/** Deterministic signature so public unsubscribe links cannot be forged. */
export function signUnsubscribe(userId: string, email: string): string {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(`${userId}:${email.toLowerCase()}`)
    .digest("hex");
}

export function verifyUnsubscribe(userId: string, email: string, signature: string): boolean {
  const expected = Buffer.from(signUnsubscribe(userId, email), "hex");
  const provided = Buffer.from(signature, "hex");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export function buildUnsubscribeUrl(userId: string, email: string): string {
  const query = new URLSearchParams({ u: userId, e: email.toLowerCase(), s: signUnsubscribe(userId, email) });
  return `${env.APP_URL}/unsubscribe?${query.toString()}`;
}

/**
 * Pure check used by the worker before every send.
 * `suppressedEmails` should be a lower-cased set of the user's suppression list.
 */
export function isSuppressed(email: string, suppressedEmails: ReadonlySet<string>): boolean {
  return suppressedEmails.has(email.toLowerCase());
}