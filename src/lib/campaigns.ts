import type { TemplateVariables } from "@/lib/personalization";
import { personalize } from "@/lib/personalization";
import { isSuppressed } from "@/lib/suppression";

export type RecipientStatus = "pending" | "sending" | "sent" | "failed" | "skipped";

export interface RecipientSeed {
  leadId: string;
  recipient: string;
  status: RecipientStatus;
  lastError?: string;
}

export interface LeadForRecipient {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  practiceName: string;
}

/**
 * Builds the set of recipients for a campaign at start time.
 * - Leads who are already suppressed are seeded as `skipped` (still logged).
 * - Dedupes on normalized email.
 * Pure, testable.
 */
export function buildRecipientSeeds(
  leads: LeadForRecipient[],
  suppressedEmails: ReadonlySet<string>,
): RecipientSeed[] {
  const seen = new Set<string>();
  const seeds: RecipientSeed[] = [];
  for (const lead of leads) {
    const email = lead.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const suppressed = isSuppressed(email, suppressedEmails);
    seeds.push({
      leadId: lead.id,
      recipient: email,
      status: suppressed ? "skipped" : "pending",
      lastError: suppressed ? "Suppressed at campaign start" : undefined,
    });
  }
  return seeds;
}

export function fillSubject(templateSubject: string, lead: TemplateVariables): string {
  return personalize(templateSubject, lead).trim();
}

/**
 * Human-friendly estimated duration for N recipients at a fixed interval.
 */
export function estimateDuration(recipientCount: number, intervalSeconds: number): string {
  const total = recipientCount * intervalSeconds;
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (recipientCount === 0) return "0 min";
  if (hours > 0) return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
  return `${Math.max(minutes, 1)} min`;
}

// ---------------------------------------------------------------------------
// Multi-mailbox campaign distribution
// ---------------------------------------------------------------------------

// Shared deterministic distribution used by the campaign start route, the UI
// preview and the REST payloads. Re-exported here (and implemented in
// campaign-distribution.ts, a zero-dependency module) so both server and
// client code import one canonical helper.
export {
  distributeRecipientsAcrossAccounts,
  distributionCounts,
  type DistributionCount,
  type DistributionResult,
} from "@/lib/campaign-distribution";

/**
 * Decides which sending platform a recipient actually sends through — the
 * single source of truth used by the worker.
 *
 * A recipient's FROZEN mailbox assignment (recorded on the row when the
 * campaign started) wins over everything. Campaigns created before
 * multi-mailbox selection existed have no per-recipient assignment and fall
 * back to the campaign-level account exactly as before.
 */
export function pickRecipientSender(input: {
  recipientSmtp: { id: string } | null;
  campaignSmtp: { id: string } | null;
  campaignMicrosoft: { id: string } | null;
  campaignGoogle: { id: string } | null;
}): { kind: "smtp" | "microsoft" | "google"; accountId: string } | null {
  const smtp = input.recipientSmtp ?? input.campaignSmtp;
  if (smtp) return { kind: "smtp", accountId: smtp.id };
  if (input.campaignMicrosoft) return { kind: "microsoft", accountId: input.campaignMicrosoft.id };
  if (input.campaignGoogle) return { kind: "google", accountId: input.campaignGoogle.id };
  return null;
}