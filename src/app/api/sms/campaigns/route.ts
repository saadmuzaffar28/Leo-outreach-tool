import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { smsCampaignCreateSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";
import { isX8Configured, sendCampaignBatch } from "@/lib/8x8";

export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();

  const campaigns = await prisma.smsCampaign.findMany({
    where: { userId: session.sub },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { messages: true } } },
  });

  return jsonResponse({ campaigns });
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = smsCampaignCreateSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid campaign");
  const data = parsed.data;

  if (!data.sendNow && !data.scheduledAt) {
    return badRequest("scheduledAt is required when scheduling");
  }

  // Only opted-in contacts owned by this user may be targeted.
  const contacts = await prisma.contact.findMany({
    where: { userId: session.sub, id: { in: data.contactIds }, optOut: false },
    select: { id: true, name: true, phoneNumber: true },
  });
  const recipients = contacts.map((c) => ({ contactId: c.id, name: c.name, phoneNumber: c.phoneNumber }));
  if (recipients.length === 0) {
    return badRequest("No valid opted-in recipients selected");
  }

  const campaign = await prisma.smsCampaign.create({
    data: {
      userId: session.sub,
      name: data.name,
      message: data.message,
      source: data.source,
      status: data.sendNow ? "sending" : "scheduled",
      scheduledAt: data.sendNow ? null : new Date(data.scheduledAt!),
    },
  });

  if (data.sendNow) {
    const summary = await sendCampaignBatch({
      userId: session.sub,
      campaignId: campaign.id,
      source: data.source,
      messageTemplate: data.message,
      recipients,
    });

    await prisma.smsCampaign.update({
      where: { id: campaign.id },
      data: {
        status: summary.failed > 0 && summary.sent === 0 ? "failed" : "sent",
        completedAt: new Date(),
      },
    });

    return jsonResponse(
      {
        campaignId: campaign.id,
        mode: isX8Configured() ? "live" : "mock",
        ...summary,
      },
      201,
    );
  }

  // Scheduled campaigns are stored; the worker picks them up at send time.
  return jsonResponse({ campaignId: campaign.id, scheduled: true }, 201);
}
