/**
 * Deterministic, balanced contact distribution across a campaign's selected
 * SMTP mailboxes.
 *
 * Pure and dependency-free so it can run on the server (campaign start) and in
 * the browser (live distribution preview) with identical results.
 *
 * ROUND-ROBIN BY INDEX is the algorithm. Each recipient i is assigned to
 * selected account (i mod N) in selection order, which:
 *
 *  - preserves recipient order exactly,
 *  - guarantees the assigned counts differ by at most 1 (balanced),
 *  - handles "more accounts than recipients" (early accounts get one, later
 *    accounts get zero),
 *  - is fully deterministic, so re-running it over the same inputs can never
 *    produce a different assignment.
 *
 * The assignment is frozen in the database when a campaign starts, so the
 * only restart-safety question is "does the worker re-derive the assignment?",
 * and it does not — it reads the mailbox stored on each recipient row.
 */

export interface DistributionCount {
  smtpAccountId: string;
  count: number;
}

export interface DistributionResult {
  /** The account id assigned to each recipient, parallel to the input array. */
  accountByRecipient: (string | null)[];
  /** Counts per selected account, in selection order (0 for unused accounts). */
  counts: DistributionCount[];
}

/** Dedupe account ids preserving first-seen order. */
function dedupeAccountIds(accountIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of accountIds) {
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Per-account contact counts for `recipientCount` recipients spread across
 * `accountIds` (round-robin by index). Any account selecting the same id twice
 * is safely deduplicated — a mailbox can never be counted twice.
 */
export function distributionCounts(
  recipientCount: number,
  accountIds: readonly string[],
): DistributionCount[] {
  const ids = dedupeAccountIds(accountIds);
  const counts = ids.map((smtpAccountId) => ({ smtpAccountId, count: 0 }));
  if (recipientCount <= 0 || ids.length === 0) return counts;
  for (let i = 0; i < recipientCount; i++) {
    counts[i % ids.length].count += 1;
  }
  return counts;
}

/**
 * Assigns each recipient to exactly one selected mailbox.
 *
 * The result is a parallel array to `recipients` — index-aligned, so "which
 * mailbox does recipient #27 send through" is `accountByRecipient[27]`. Every
 * recipient is assigned to exactly one mailbox (or to null when no mailboxes
 * are selected). Recipient ORDER is preserved; a mailbox is never duplicated.
 */
export function distributeRecipientsAcrossAccounts(
  recipients: readonly unknown[],
  accountIds: readonly string[],
): DistributionResult {
  const ids = dedupeAccountIds(accountIds);
  const accountByRecipient = recipients.map((_r, i) =>
    ids.length === 0 ? null : ids[i % ids.length],
  );
  const counts = ids.map((smtpAccountId) => {
    let count = 0;
    for (const assigned of accountByRecipient) {
      if (assigned === smtpAccountId) count += 1;
    }
    return { smtpAccountId, count };
  });
  return { accountByRecipient, counts };
}