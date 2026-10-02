import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { assertSameOrigin, forbidden, jsonResponse, notFound } from "@/lib/http";

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getSession();
  if (!session) return forbidden();

  const campaign = await prisma.smsCampaign.findFirst({
    where: { id: params.id, userId: session.sub },
  });
  if (!campaign) return notFound("Campaign not found");

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("pageSize") ?? "25") || 25));
  const search = (url.searchParams.get("search") ?? "").trim();

  const where = {
    campaignId: campaign.id,
    ...(search
      ? {
          OR: [
            { phoneNumber: { contains: search } },
            { message: { contains: search, mode: "insensitive" as const } },
            { contact: { name: { contains: search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const [total, messages] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { contact: { select: { name: true } } },
    }),
  ]);

  return jsonResponse({ campaign, total, page, pageSize, messages });
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  const campaign = await prisma.smsCampaign.findFirst({
    where: { id: params.id, userId: session.sub },
    select: { id: true },
  });
  if (!campaign) return notFound("Campaign not found");

  await prisma.smsCampaign.delete({ where: { id: campaign.id } });
  return jsonResponse({ ok: true });
}
