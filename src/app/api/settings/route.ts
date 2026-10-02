import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSendSettings, updateSendSettings } from "@/lib/settings";
import { sendSettingsUpdateSchema } from "@/lib/validation";
import { dailyKey, getDailyCounter, isQuotaPaused } from "@/lib/quota";
import { assertSameOrigin, badRequest, forbidden, jsonResponse } from "@/lib/http";

export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();

  const [settings, googleAccounts, microsoftAccounts] = await Promise.all([
    getSendSettings(session.sub),
    prisma.googleAccount.findMany({
      where: { userId: session.sub },
      orderBy: { createdAt: "desc" },
    }),
    prisma.microsoftAccount.findMany({
      where: { userId: session.sub },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const today = dailyKey();
  const googleUsage = await Promise.all(
    googleAccounts.map(async (a) => {
      const c = await getDailyCounter("google", a.id, session.sub, today);
      return {
        accountId: a.id,
        provider: "google" as const,
        email: a.googleEmail,
        date: today,
        messagesSent: c.messagesSent,
        messagesFailed: c.messagesFailed,
        messagesSkipped: c.messagesSkipped,
        quotaPaused: isQuotaPaused(a.quotaPausedUntil),
        quotaPausedUntil: a.quotaPausedUntil,
        quotaMessage: a.quotaMessage,
        consecutiveQuotaHits: a.consecutiveQuotaHits,
      };
    }),
  );
  const microsoftUsage = await Promise.all(
    microsoftAccounts.map(async (a) => {
      const c = await getDailyCounter("microsoft", a.id, session.sub, today);
      return {
        accountId: a.id,
        provider: "microsoft" as const,
        email: a.microsoftEmail,
        date: today,
        messagesSent: c.messagesSent,
        messagesFailed: c.messagesFailed,
        messagesSkipped: c.messagesSkipped,
        quotaPaused: isQuotaPaused(a.quotaPausedUntil),
        quotaPausedUntil: a.quotaPausedUntil,
        quotaMessage: a.quotaMessage,
        consecutiveQuotaHits: a.consecutiveQuotaHits,
      };
    }),
  );
  const usage = [...googleUsage, ...microsoftUsage];

  return jsonResponse({ settings, usage });
}

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
  const parsed = sendSettingsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid settings");
  }

  const settings = await updateSendSettings(session.sub, parsed.data);
  return jsonResponse({ ok: true, settings });
}