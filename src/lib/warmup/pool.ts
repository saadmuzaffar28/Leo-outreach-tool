/**
 * Warm-up message pool / rotation.
 *
 * SAFETY PROPERTY THIS MODULE ENFORCES: a warm-up message may only ever be
 * delivered to a mailbox the operator has explicitly enrolled in the warm-up
 * pool. There is no code path that can produce an external recipient, because
 * the receiver is always chosen from the enrolled pool and the job row carries
 * a foreign key to a real SmtpAccount. Campaign templates, campaign recipients
 * and the lead/suppression tables are never consulted here.
 *
 * Pure functions -- the caller loads the pool from the database.
 */

export interface PoolMember {
  /** SmtpAccount id. */
  id: string;
  email: string;
}

/**
 * Deterministic-ish rotation: pick the receiver for this send.
 *
 * `cursor` advances by one per send so consecutive sends from one mailbox land
 * on different receivers and the load is spread. The SAME mailbox is never
 * chosen as its own receiver when the pool has more than one member.
 *
 * Takes the sender as a PoolMember (not a bare id) so it matches
 * {@link eligibleReceivers} and {@link pickReceiverPreferCrossDomain}. Passing
 * a member where an id was expected previously produced silent self-delivery.
 *
 * Returns null when the pool is unusable (empty, or a single mailbox -- which
 * would mean sending to itself).
 */
export function pickReceiver(pool: PoolMember[], sender: PoolMember, cursor: number): PoolMember | null {
  if (pool.length < 2) return null;
  const idx = ((cursor % pool.length) + pool.length) % pool.length;
  const first = pool[idx];
  if (first && first.id !== sender.id) return first;
  // Pool position is the sender: fall through to the next distinct member.
  const next = pool[(idx + 1) % pool.length];
  return next && next.id !== sender.id ? next : null;
}

/**
 * Domain of an email address, lowercased. Returns "" when there is no "@".
 * Used for grouping/display only.
 */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

/**
 * Normalise an email for comparison. Used to guarantee a mailbox can never be
 * scheduled to deliver to itself even if two SmtpAccount rows shared an address.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Build the eligible receiver pool for a sender: every enrolled, enabled
 * member of the same user's pool EXCEPT the sender itself and any mailbox whose
 * address matches the sender's (defence in depth against self-delivery).
 */
export function eligibleReceivers(
  pool: PoolMember[],
  sender: PoolMember,
): PoolMember[] {
  const senderAddr = normalizeEmail(sender.email);
  return pool.filter((m) => m.id !== sender.id && normalizeEmail(m.email) !== senderAddr);
}

/**
 * Preferred pairing: a receiver on a DIFFERENT domain from the sender, if one
 * is enrolled. Same-domain delivery is a weaker signal than cross-domain, so we
 * prefer cross-domain but never require it. Returns null if none available.
 */
export function pickReceiverPreferCrossDomain(
  pool: PoolMember[],
  sender: PoolMember,
  cursor: number,
): PoolMember | null {
  const candidates = eligibleReceivers(pool, sender);
  if (candidates.length === 0) return null;

  const senderDomain = emailDomain(sender.email);
  const start = ((cursor % candidates.length) + candidates.length) % candidates.length;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[(start + i) % candidates.length];
    if (emailDomain(candidate.email) !== senderDomain) return candidate;
  }
  return candidates[start];
}