import { prisma } from "@/lib/prisma";
import { getSession, isOwner } from "@/lib/auth";
import { groupMembersSchema, removeGroupMemberSchema } from "@/lib/validation";
import { addLeadsToGroup } from "@/lib/groups";
import {
  assertSameOrigin,
  badRequest,
  forbidden,
  jsonResponse,
  notFound,
} from "@/lib/http";

export const runtime = "nodejs";

const PAGE_SIZE = 50;

/** The leads belonging to a group, with search and pagination. */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return forbidden();

  const group = await prisma.group.findUnique({ where: { id: params.id } });
  if (!group || !isOwner(session, group.userId)) return notFound("Group not found");

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);

  const where = {
    // Scope to this group AND the owner. Without the `leadGroups` filter this
    // would silently return every lead the user has.
    groupId: group.id,
    lead: {
      userId: session.sub,
      ...(q
        ? {
            OR: [
              { firstName: { contains: q, mode: "insensitive" as const } },
              { lastName: { contains: q, mode: "insensitive" as const } },
              { email: { contains: q, mode: "insensitive" as const } },
              { practiceName: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
  };

  const [total, memberships] = await Promise.all([
    prisma.leadGroup.count({ where }),
    prisma.leadGroup.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        lead: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            practiceName: true,
            phone: true,
            customField1: true,
            customField2: true,
            createdAt: true,
          },
        },
      },
    }),
  ]);

  return jsonResponse({
    group: { id: group.id, name: group.name, description: group.description },
    total,
    page,
    pageSize: PAGE_SIZE,
    contacts: memberships.map((m) => ({
      ...m.lead,
      addedAt: m.createdAt,
    })),
  });
}

/** Adds existing leads to this group. Never creates or duplicates a lead. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = groupMembersSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid selection");
  }

  const group = await prisma.group.findUnique({ where: { id: params.id } });
  if (!group || !isOwner(session, group.userId)) return notFound("Group not found");

  // Never let a caller attach another user's leads.
  const owned = await prisma.lead.findMany({
    where: { id: { in: parsed.data.leadIds }, userId: session.sub },
    select: { id: true },
  });
  if (owned.length === 0) return badRequest("No matching contacts found");

  const result = await addLeadsToGroup(
    group.id,
    owned.map((l) => l.id),
  );

  return jsonResponse({
    ok: true,
    added: result.added,
    alreadyPresent: result.alreadyPresent,
  });
}

/** Removes one contact from the group. The lead itself is kept. */
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = removeGroupMemberSchema.safeParse(body);
  if (!parsed.success) return badRequest("leadId is required");

  const group = await prisma.group.findUnique({ where: { id: params.id } });
  if (!group || !isOwner(session, group.userId)) return notFound("Group not found");

  const result = await prisma.leadGroup.deleteMany({
    where: { groupId: group.id, leadId: parsed.data.leadId },
  });

  if (result.count === 0) {
    return badRequest("That contact is not in this group");
  }

  return jsonResponse({ ok: true, removed: result.count, leadKept: true });
}
