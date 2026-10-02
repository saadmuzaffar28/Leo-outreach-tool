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