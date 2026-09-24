import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { forbidden, jsonResponse } from "@/lib/http";

/**
 * Inbox API.
 * GET without `phoneNumber` → conversation list (one row per number).
 * GET with `?phoneNumber=...` → full message history for that thread.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return forbidden();

  const url = new URL(req.url);
  const phoneNumber = url.searchParams.get("phoneNumber");

  if (!phoneNumber) {
    const messages = await prisma.message.findMany({
      where: {
        userId: session.sub,
        phoneNumber: { not: "" },
        OR: [{ direction: "inbound" }, { direction: "outbound" }],
      },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        contact: { select: { name: true } },
        campaign: { select: { name: true } },
      },
    });

    // Group into conversations keyed by phone number.
    const convos = new Map<
      string,
      {
        phoneNumber: string;
        contactName: string | null;
        campaignName: string | null;
        lastMessage: string;
        lastDirection: string;
        lastAt: Date;
        unreadInbound: number;
      }
    >();

    for (const m of messages) {
      const existing = convos.get(m.phoneNumber);
      if (existing) {
        if (m.direction === "inbound") existing.unreadInbound += 0; // already counted below
        continue;
      }
      convos.set(m.phoneNumber, {
        phoneNumber: m.phoneNumber,
        contactName: m.contact?.name ?? null,
        campaignName: m.campaign?.name ?? null,
        lastMessage: m.message,
        lastDirection: m.direction,
        lastAt: m.createdAt,
        unreadInbound: 0,
      });
    }

    const list = Array.from(convos.values()).sort(
      (a, b) => b.lastAt.getTime() - a.lastAt.getTime(),
    );
    return jsonResponse({ conversations: list });
  }

  const thread = await prisma.message.findMany({
    where: { userId: session.sub, phoneNumber },
    orderBy: { createdAt: "asc" },
    take: 200,
    include: {
      contact: { select: { name: true } },
      campaign: { select: { id: true, name: true } },
    },
  });

  const replies = await prisma.reply.findMany({
    where: { userId: session.sub, phoneNumber },
    orderBy: { receivedAt: "asc" },
  });

  return jsonResponse({ phoneNumber, messages: thread, replies });
}
