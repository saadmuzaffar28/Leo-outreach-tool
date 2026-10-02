/**
 * Pure warm-up ramp / window arithmetic. No database, no I/O -- every function
 * here is deterministic and unit tested.
 *
 * DESIGN COMMITMENT: this module deliberately makes NO claim about how many
 * days a mailbox needs before it is "safe" to send at volume. It computes a
 * configured ramp curve and nothing more. Warm-up completion never raises a
 * campaign send limit.
 */

export interface RampConfig {
  startingDailyVolume: number;
  dailyIncrease: number;
  maximumDailyVolume: number;
}

/**
 * Target volume for a given ramp day, clamped to the configured maximum.
 *
 * Day 1 => startingDailyVolume
 * Day n => startingDailyVolume + dailyIncrease * (n - 1)
 * Never exceeds maximumDailyVolume, and never drops below startingDailyVolume.
 *
 * Note this is the *ramp target*, which is then further constrained by the
 * mailbox's real remaining daily budget (which campaigns also draw from). The
 * ramp is an upper bound on warm-up, never a promise that volume is available.
 */
export function targetForDay(day: number, cfg: RampConfig): number {
  const safeDay = Math.max(1, Math.floor(day));
  const raw = cfg.startingDailyVolume + cfg.dailyIncrease * (safeDay - 1);
  return Math.min(raw, cfg.maximumDailyVolume);
}

/**
 * The ramp day a mailbox is on, derived from how many DISTINCT days it has been
 * active. Pausing for two days and resuming does not jump the ramp forward:
 * the mailbox resumes on the day it left off.
 */
export function nextRampDay(currentDay: number, hasAlreadyRunToday: boolean): number {
  if (currentDay < 1) return 1;
  return hasAlreadyRunToday ? currentDay : currentDay + 1;
}

/** Parse "HH:mm" into minutes-since-midnight, or null if malformed. */
export function parseHhMm(value: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * True when `now` (a local-time Date) falls inside the configured warm-up window.
 *
 * A window whose end is EARLIER than its start (e.g. 22:00 -> 06:00) is treated
 * as wrapping past midnight. An unparseable window is treated as "always open"
 * so a typo can never silently wedge a mailbox shut -- but the worker also
 * validates the format on save, so this is a belt-and-braces fallback.
 */
export function isWithinWindow(now: Date, start: string, end: string): boolean {
  const s = parseHhMm(start);
  const e = parseHhMm(end);
  if (s === null || e === null) return true;
  const mins = now.getHours() * 60 + now.getMinutes();
  if (s === e) return true; // zero-width window means "no restriction"
  return s < e ? mins >= s && mins < e : mins >= s || mins < e;
}

/**
 * A random delay in [min, max] seconds, inclusive. Inverted bounds are swapped
 * rather than producing a negative range.
 */
export function pickDelaySeconds(min: number, max: number): number {
  const lo = Math.max(0, Math.min(Math.floor(min), Math.floor(max)));
  const hi = Math.max(0, Math.max(Math.floor(min), Math.floor(max)));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * How many more warm-up messages this mailbox may still send today.
 *
 * `budgetLeft` is the SHARED per-mailbox daily budget (campaign + warm-up),
 * already computed by the caller from DailySendCounter. `sentToday` is what
 * warm-up alone has used. This can never return a negative number, and it can
 * never allow warm-up to exceed the shared budget.
 */
export function warmupAllowance(
  budgetLeft: number,
  sentToday: number,
  target: number,
): number {
  return Math.max(0, Math.min(target - sentToday, budgetLeft));
}

/** A ramp is finished once the day-N target has hit the configured maximum. */
export function isRampComplete(day: number, cfg: RampConfig): boolean {
  return targetForDay(day, cfg) >= cfg.maximumDailyVolume;
}

/** Number of days the ramp takes to walk from `starting` up to `maximum`. */
export function rampLength(cfg: RampConfig): number {
  if (cfg.dailyIncrease <= 0) return 1;
  const steps = Math.ceil((cfg.maximumDailyVolume - cfg.startingDailyVolume) / cfg.dailyIncrease);
  return Math.max(1, steps + 1);
}