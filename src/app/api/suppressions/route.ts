import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { suppressionCreateSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse } from "@/lib/http";

export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();
  const suppressions = await prisma.suppression.findMany({
    where: { userId: session.sub },
    orderBy: { createdAt: "desc" },
  });
  return jsonResponse({ suppressions });
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
  const parsed = suppressionCreateSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid email");

  const item = await prisma.suppression.upsert({
    where: { userId_email: { userId: session.sub, email: parsed.data.email } },
    update: { reason: parsed.data.reason },
    create: {
      userId: session.sub,
      email: parsed.data.email,
      reason: parsed.data.reason,
    },
  });
  return jsonResponse({ suppression: item }, 201);
}