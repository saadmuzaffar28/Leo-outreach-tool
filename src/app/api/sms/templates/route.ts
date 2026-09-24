import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { smsTemplateSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse } from "@/lib/http";

export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();

  const templates = await prisma.smsTemplate.findMany({
    where: { userId: session.sub },
    orderBy: { updatedAt: "desc" },
  });
  return jsonResponse({ templates });
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
  const parsed = smsTemplateSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid template");

  const template = await prisma.smsTemplate.create({
    data: {
      userId: session.sub,
      name: parsed.data.name,
      message: parsed.data.message,
    },
  });
  return jsonResponse({ template }, 201);
}
