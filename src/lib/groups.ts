import { prisma } from "@/lib/prisma";
import type { LeadForRecipient } from "@/lib/campaigns";

/** Longest accepted group name. Postgres TEXT is unbounded, so cap it in the app. */
export const GROUP_NAME_MAX = 120;
export const GROUP_DESCRIPTION_MAX = 500;

/**
 * Canonical form of a group name: trimmed, internal whitespace collapsed to a
 * single space. Used before persisting AND before the uniqueness check so that
 * " Dental  Practices " and "Dental Practices" collide instead of creating
 * two groups that look identical in the UI.
 */
export function normalizeGroupName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export function normalizeGroupDescription(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export interface GroupNameCheck {
  ok: boolean;
  value: string;
  message?: string;
}

/** Pure name validation, shared by the create and rename routes. */
export function checkGroupName(raw: string, existingNames: string[] = []): GroupNameCheck {
  const value = normalizeGroupName(raw ?? "");
  if (value.length === 0) return { ok: false, value, message: "Group name is required" };
  if (value.length > GROUP_NAME_MAX) {
    return { ok: false, value, message: `Group name must be ${GROUP_NAME_MAX} characters or fewer` };
  }
  const clash = existingNames.some((n) => normalizeGroupName(n).toLowerCase() === value.toLowerCase());
  if (clash) return { ok: false, value, message: `A group named "${value}" already exists` };
  return { ok: true, value };
}

/**
 * The Prisma `where` used to select the leads a campaign should target.
 * `null` groupId means "every lead" - this is the pre-Groups behaviour and is
 * kept so existing campaigns with no group keep working untouched.
 */
export function groupLeadWhere(userId: string, groupId: string | null): {
  userId: string;
  leadGroups?: { some: { groupId: string } };
} {
  return groupId ? { userId, leadGroups: { some: { groupId } } } : { userId };
}

/** Shape returned to the campaign form / group list. */
export interface GroupSummary {
  id: string;
  name: string;
  description: string | null;
  contactCount: number;
  createdAt: Date;
}

/** Lists a user's groups with their live contact counts, newest-name first. */
export async function listGroups(userId: string): Promise<GroupSummary[]> {
  const groups = await prisma.group.findMany({
    where: { userId },
    orderBy: { name: "asc" },
    include: { _count: { select: { leadGroups: true } } },
  });
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    contactCount: g._count.leadGroups,
    createdAt: g.createdAt,
  }));
}

export async function countGroupContacts(userId: string, groupId: string): Promise<number> {
  return prisma.leadGroup.count({ where: { groupId, group: { userId } } });
}

/**
 * Resolves the leads a campaign should send to, in the shape
 * `buildRecipientSeeds` already consumes. This is the single place that turns a
 * group into a recipient candidate list, so the campaign form's count and the
 * worker's actual send list can never disagree.
 */
export async function resolveGroupLeads(
  userId: string,
  groupId: string | null,
): Promise<LeadForRecipient[]> {
  const leads = await prisma.lead.findMany({
    where: groupLeadWhere(userId, groupId),
    select: { id: true, email: true, firstName: true, lastName: true, practiceName: true },
  });
  return leads.map((l) => ({
    id: l.id,
    email: l.email,
    firstName: l.firstName,
    lastName: l.lastName ?? "",
    practiceName: l.practiceName ?? "",
  }));
}

/**
 * Adds leads to a group, ignoring ones already present. Returns how many links
 * were actually created so the import summary can report honestly.
 */
export async function addLeadsToGroup(
  groupId: string,
  leadIds: string[],
): Promise<{ added: number; alreadyPresent: number }> {
  const unique = Array.from(new Set(leadIds));
  if (unique.length === 0) return { added: 0, alreadyPresent: 0 };

  const existing = await prisma.leadGroup.findMany({
    where: { groupId, leadId: { in: unique } },
    select: { leadId: true },
  });
  const present = new Set(existing.map((e) => e.leadId));
  const toAdd = unique.filter((id) => !present.has(id));

  if (toAdd.length > 0) {
    await prisma.leadGroup.createMany({
      data: toAdd.map((leadId) => ({ groupId, leadId })),
      skipDuplicates: true,
    });
  }
  return { added: toAdd.length, alreadyPresent: existing.length };
}
