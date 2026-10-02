import { prisma } from "@/lib/prisma";
import { getSession, isOwner } from "@/lib/auth";
import { groupUpdateSchema } from "@/lib/validation";
import {
  checkGroupName,
  countGroupContacts,
  normalizeGroupDescription,
} from "@/lib/groups";
import {
  assertSameOrigin,
  badRequest,
  forbidden,
  jsonResponse,
  notFound,
} from "@/lib/http";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return forbidden();

  const group = await prisma.group.findUnique({
    where: { id: params.id },
    include: { _count: { select: { leadGroups: true } } },
  });
  if (!group || !isOwner(session, group.userId)) return notFound("Group not found");

  return jsonResponse({
    group: {
      id: group.id,
      name: group.name,
      description: group.description,
      contactCount: group._count.leadGroups,
      createdAt: group.createdAt,
    },
  });
}

/** Rename and/or edit the description. */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = groupUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid update");
  }

  const group = await prisma.group.findUnique({ where: { id: params.id } });
  if (!group || !isOwner(session, group.userId)) return notFound("Group not found");

  const data: { name?: string; description?: string | null } = {};

  if (parsed.data.name !== undefined) {
    const siblings = (
      await prisma.group.findMany({
        where: { userId: group.userId, id: { not: group.id } },
        select: { name: true },
      })
    ).map((g) => g.name);
    const check = checkGroupName(parsed.data.name, siblings);
    if (!check.ok) return badRequest(check.message!);
    data.name = check.value;
  }

  if (parsed.data.description !== undefined) {
    data.description = normalizeGroupDescription(parsed.data.description);
  }

  const updated = await prisma.group.update({ where: { id: group.id }, data });
  const contactCount = await countGroupContacts(session.sub, updated.id);

  return jsonResponse({ group: { ...updated, contactCount } });
}

/**
 * Deletes the group and nothing else.
 *
 * The membership join rows go with it via ON DELETE CASCADE, but the Lead rows
 * they pointed at are untouched - every contact stays in "All Contacts".
 * Campaigns keep their history; their recipientGroupId is set to NULL by
 * ON DELETE SET NULL rather than cascading.
 */
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  const group = await prisma.group.findUnique({
    where: { id: params.id },
    include: { _count: { select: { leadGroups: true } } },
  });
  if (!group || !isOwner(session, group.userId)) return notFound("Group not found");

  const contactCount = group._count.leadGroups;

  await prisma.group.delete({ where: { id: group.id } });

  return jsonResponse({
    ok: true,
    deletedGroup: group.name,
    contactsKept: contactCount,
  });
}
