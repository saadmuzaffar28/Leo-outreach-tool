import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { assertSameOrigin, forbidden, jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function DELETE(req: Request) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  const result = await prisma.lead.deleteMany({ where: { userId: session.sub } });
  return jsonResponse({ ok: true, deleted: result.count });
}