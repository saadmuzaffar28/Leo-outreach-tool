import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { forbidden, jsonResponse } from "@/lib/http";

export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();

  const total = await prisma.lead.count({ where: { userId: session.sub } });
  const withEmail = await prisma.lead.count({
    where: { userId: session.sub, email: { not: "" } },
  });
  return jsonResponse({ total, withEmail });
}