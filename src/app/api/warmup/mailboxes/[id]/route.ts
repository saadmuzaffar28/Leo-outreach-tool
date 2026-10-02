import { getSession } from "@/lib/auth";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";
import { ensureWarmupSettings, listWarmupMailboxes } from "@/lib/warmup/service";
import { warmupMailboxSettingsSchema } from "@/lib/warmup/validation";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/warmup/mailboxes/[id] — per-mailbox warm-up configuration.
 *
 * `[id]` is the SmtpAccount id (the same id the dashboard lists), which keeps
 * the UI free of a second identifier. PATCH on an un-enrolled mailbox enrols it
 * disabled, so configuration alone never starts traffic.
 *
 * SECURITY: accepts no credential fields. IMAP credentials are edited through
 * the SMTP account route, never here.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();
  const { id } = await params;

  const account = await prisma.smtpAccount.findUnique({ where: { id } });
  if (!account || account.userId !== session.sub) return notFound();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = warmupMailboxSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid warm-up settings");
  }

  // Enrol first (defaults from global settings) so cross-field invariants such
  // as start <= maximum are checked against real values, not partial input.
  const existing = await ensureWarmupSettings(session.sub, id);
  const merged = { ...existing, ...parsed.data };

  // Re-validate the MERGED result: a partial PATCH that is individually valid
  // can still break the relationship with the stored value.
  const mergedCheck = warmupMailboxSettingsSchema.safeParse({
    startingDailyVolume: merged.startingDailyVolume,
    maximumDailyVolume: merged.maximumDailyVolume,
    dailyIncrease: merged.dailyIncrease,
    minimumDelaySeconds: merged.minimumDelaySeconds,
    maximumDelaySeconds: merged.maximumDelaySeconds,
    maxConsecutiveFailures: merged.maxConsecutiveFailures,
    warmupWindowStart: merged.warmupWindowStart,
    warmupWindowEnd: merged.warmupWindowEnd,
  });
  if (!mergedCheck.success) {
    return badRequest(mergedCheck.error.issues[0]?.message ?? "Invalid warm-up settings");
  }

  // `enabled` is only meaningful through the start/pause actions, which have
  // their own safety checks (e.g. needing a partner mailbox). Silently flipping
  // it here would bypass them.
  const { enabled: _ignored, ...config } = parsed.data;
  void _ignored;

  await prisma.warmupMailboxSettings.update({
    where: { smtpAccountId: id },
    data: config,
  });

  const mailboxes = await listWarmupMailboxes(session.sub);
  return jsonResponse({ ok: true, mailbox: mailboxes.find((m) => m.smtpAccountId === id) ?? null });
}