/**
 * Address normalization + list parsing for verification.
 *
 * Normalization MUST match the cache key rule: trim + lowercase. Everything
 * that stores or looks up a verification (worker, API, campaign gate) goes
 * through these helpers so two spellings of one address share one record.
 */

import { z } from "zod";

/** Trimmed + lowercased address. The single cache key format. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Strict format check (zod's email rule — the same one used by
 * `emailSchema` in src/lib/validation.ts and by the CSV importer, so
 * verification accepts exactly what the rest of the app accepts).
 */
const singleEmailSchema = z.string().trim().email();

export function isPlausibleEmail(email: string): boolean {
  return singleEmailSchema.safeParse(email).success;
}

/** Normalizes when valid; returns null for addresses that cannot be verified. */
export function normalizeOrNull(email: string): string | null {
  const normalized = normalizeEmail(email);
  return isPlausibleEmail(normalized) ? normalized : null;
}

export interface ParsedEmailList {
  /** Valid, normalized, deduplicated (first occurrence wins, order kept). */
  emails: string[];
  /** Valid entries removed because they duplicated an earlier entry. */
  duplicates: number;
  /** Entries that failed format validation. */
  invalid: number;
}

/**
 * Turns arbitrary pasted/CSV text into a clean list: splits on commas,
 * semicolons, tabs, whitespace and newlines, drops an optional header line
 * ("email", "e-mail", "email address"), then normalizes + dedupes.
 */
export function parseEmailList(text: string): ParsedEmailList {
  const raw = text
    .split(/[\s,;\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const emails: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let invalid = 0;

  for (const entry of raw) {
    // Tolerate an "email" column header at the top of a pasted CSV column.
    if (emails.length === 0 && seen.size === 0 && /^(e-?mail( address)?)$/i.test(entry)) {
      continue;
    }
    const normalized = normalizeOrNull(entry);
    if (!normalized) {
      invalid++;
      continue;
    }
    if (seen.has(normalized)) {
      duplicates++;
      continue;
    }
    seen.add(normalized);
    emails.push(normalized);
  }

  return { emails, duplicates, invalid };
}
