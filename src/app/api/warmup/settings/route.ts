import { getSession } from "@/lib/auth";
import { assertSameOrigin, badRequest, forbidden, jsonResponse } from "@/lib/http";
import { getSendSettings, updateSendSettings, DEFAULT_SEND_SETTINGS } from "@/lib/settings";
import { warmupGlobalSettingsSchema } from "@/lib/warmup/validation";

export const dynamic = "force-dynamic";

/**
 * GET /api/warmup/settings — global warm-up defaults.
 *
 * These are DEFAULTS applied when a mailbox is enrolled. Changing them does not
 * retune mailboxes that already have their own WarmupMailboxSettings row.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();
  const settings = await getSendSettings(session.sub);
  return jsonResponse({
    settings: {
      warmupEnabled: settings.warmupEnabled,
      warmupStartingDailyVolume: settings.warmupStartingDailyVolume,
      warmupDailyIncrease: settings.warmupDailyIncrease,
      warmupMaximumDailyVolume: settings.warmupMaximumDailyVolume,
      warmupMinDelaySeconds: settings.warmupMinDelaySeconds,
      warmupMaxDelaySeconds: settings.warmupMaxDelaySeconds,
    },
    defaults: DEFAULT_SEND_SETTINGS,
  });
}

/** PATCH /api/warmup/settings — update the global warm-up defaults. */
export async function PATCH(req: Request) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = warmupGlobalSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid warm-up settings");
  }

  const settings = await updateSendSettings(session.sub, parsed.data);
  return jsonResponse({
    ok: true,
    settings: {
      warmupEnabled: settings.warmupEnabled,
      warmupStartingDailyVolume: settings.warmupStartingDailyVolume,
      warmupDailyIncrease: settings.warmupDailyIncrease,
      warmupMaximumDailyVolume: settings.warmupMaximumDailyVolume,
      warmupMinDelaySeconds: settings.warmupMinDelaySeconds,
      warmupMaxDelaySeconds: settings.warmupMaxDelaySeconds,
    },
  });
}