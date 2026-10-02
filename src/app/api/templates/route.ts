import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { templateSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse } from "@/lib/http";
import { assertOnlySupportedVariables } from "@/lib/personalization";

export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();
  const templates = await prisma.emailTemplate.findMany({
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
  const parsed = templateSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid template");

  try {
    assertOnlySupportedVariables(parsed.data.subject + "\n" + parsed.data.body);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  const template = await prisma.emailTemplate.create({
    data: {
      userId: session.sub,
      ...parsed.data,
      signatureOverride: parsed.data.signatureOverride?.trim()
        ? parsed.data.signatureOverride
        : null,
    },
  });
  return jsonResponse({ template }, 201);
}