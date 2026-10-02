import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { groupCreateSchema } from "@/lib/validation";
import {
  checkGroupName,
  listGroups,
  normalizeGroupDescription,
} from "@/lib/groups";
import { assertSameOrigin, badRequest, forbidden, jsonResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();

  const groups = await listGroups(session.sub);
  return jsonResponse({ groups });
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
  const parsed = groupCreateSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid group");
  }

  // Reject duplicates up front so the user gets a clear message instead of a
  // Prisma P2002. The DB unique index is still the real guarantee.
  const existingNames = (
    await prisma.group.findMany({ where: { userId: session.sub }, select: { name: true } })
  ).map((g) => g.name);

  const check = checkGroupName(parsed.data.name, existingNames);
  if (!check.ok) return badRequest(check.message!);

  const group = await prisma.group.create({
    data: {
      userId: session.sub,
      name: check.value,
      description: normalizeGroupDescription(parsed.data.description),
    },
  });

  return jsonResponse(
    { group: { ...group, contactCount: 0 } },
    201,
  );
}
