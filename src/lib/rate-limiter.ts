/**
 * Per-account in-process rate limiting. The daily limit is enforced
 * separately against the persistent DailySendCounter; this limiter only
 * smooths the flow of individual API calls (messages/min + minimum delay).
 */

export interface SendRatePolicy {
  messagesPerMinute: number;
  minDelaySeconds: number;
}

/** Token bucket: refills `refillPerSecond` tokens/sec up to `capacity`. */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private capacity: number,
    private refillPerSecond: number,
    now: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.lastRefill = now;
  }

  /** Consumes one token if available (refills first). Returns false if empty. */
  tryTake(now: number = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Enforces both the per-minute token budget and a hard minimum delay
 * between sends for each account. In-memory only — each worker keeps its
 * own limiter, and the persistent daily counter guards the daily budget.
 */
export class SendRateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private lastSentAt = new Map<string, number>();

  canSend(accountKey: string, policy: SendRatePolicy, now: number = Date.now()): boolean {
    let bucket = this.buckets.get(accountKey);
    if (!bucket) {
      bucket = new TokenBucket(policy.messagesPerMinute, policy.messagesPerMinute / 60, now);
      this.buckets.set(accountKey, bucket);
    }
    const last = this.lastSentAt.get(accountKey);
    if (last !== undefined && now - last < policy.minDelaySeconds * 1000) return false;
    return bucket.tryTake(now);
  }

  /** Records a successful send so the min-delay window applies. */
  recordSend(accountKey: string, now: number = Date.now()): void {
    this.lastSentAt.set(accountKey, now);
  }

  /** Time in ms before this account may send again, or 0 if allowed now. */
  timeToNextSend(accountKey: string, policy: SendRatePolicy, now: number = Date.now()): number {
    const last = this.lastSentAt.get(accountKey);
    if (last === undefined) return 0;
    const minDelayMs = policy.minDelaySeconds * 1000;
    if (now - last < minDelayMs) return minDelayMs - (now - last);
    return 0;
  }
}

export const effectiveMessagesPerMinute = (policy: SendRatePolicy): number =>
  Math.min(policy.messagesPerMinute, Math.floor(60 / Math.max(1, policy.minDelaySeconds)));