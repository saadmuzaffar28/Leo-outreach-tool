import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { parseCsv } from "@/lib/csv";
import { leadImportSaveSchema } from "@/lib/validation";
import {
  addLeadsToGroup,
  checkGroupName,
  normalizeGroupDescription,
} from "@/lib/groups";
import { assertSameOrigin, badRequest, forbidden, jsonResponse, notFound } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Imports CSV leads and, when a destination group is supplied, attaches every
 * valid contact to it.
 *
 * Duplicate policy (requirement: never create a second copy of a contact):
 *   - `Lead` is unique on [userId, email], so the address is the identity.
 *   - A contact that already exists is NOT recreated. It is linked to the
 *     target group and reported under `duplicates`.
 *   - A contact repeated inside the same file is collapsed to one lead.
 * Existing leads are never modified or deleted by an import.
 */
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

  const parsedBody = leadImportSaveSchema.safeParse(body);
  if (!parsedBody.success) {
    return badRequest(parsedBody.error.issues[0]?.message ?? "Invalid import request");
  }
  const { csv, groupId, groupName } = parsedBody.data;

  // ---------------------------------------------------------------- group
  let group: { id: string; name: string } | null = null;

  if (groupId) {
    const found = await prisma.group.findUnique({ where: { id: groupId } });
    if (!found || found.userId !== session.sub) return notFound("Group not found");
    group = { id: found.id, name: found.name };
  } else if (groupName && groupName.length > 0) {
    const existingNames = (
      await prisma.group.findMany({ where: { userId: session.sub }, select: { name: true } })
    ).map((g) => g.name);
    const check = checkGroupName(groupName, existingNames);
    if (!check.ok) return badRequest(check.message!);
    const created = await prisma.group.create({
      data: {
        userId: session.sub,
        name: check.value,
        description: normalizeGroupDescription(null),
      },
    });
    group = { id: created.id, name: created.name };
  }

  // ------------------------------------------------------------- existing
  const existingLeads = await prisma.lead.findMany({
    where: { userId: session.sub },
    select: { id: true, email: true },
  });
  const byEmail = new Map(existingLeads.map((l) => [l.email.toLowerCase(), l.id]));

  // ---------------------------------------------------------------- parse
  const result = parseCsv(csv, Array.from(byEmail.keys()));

  if (result.totalRows === 0) {
    return badRequest(
      "No data rows found in the CSV. The file needs a header row and at least one contact.",
    );
  }

  const validRows = result.candidates.filter((c) => c.errors.length === 0);
  const invalid = result.candidates.length - validRows.length;

  if (validRows.length === 0) {
    // Nothing usable: report it as a failure rather than a 0-count "success".
    const sample = result.candidates[0]?.errors[0]?.message;
    return badRequest(
      `No importable contacts found - all ${invalid} row(s) are invalid${
        sample ? ` (e.g. ${sample})` : ""
      }.`,
    );
  }

  // One lead per address, whether it already exists or not.
  const wantedEmails = Array.from(new Set(validRows.map((c) => c.data.email.toLowerCase())));
  const missing = wantedEmails.filter((e) => !byEmail.has(e));

  if (missing.length > 0) {
    await prisma.lead.createMany({
      data: missing.map((email) => {
        const row = validRows.find((c) => c.data.email.toLowerCase() === email)!;
        return {
          userId: session.sub,
          firstName: row.data.firstName,
          lastName: row.data.lastName,
          email: row.data.email,
          practiceName: row.data.practiceName,
          phone: row.data.phone,
          customField1: row.data.customField1,
          customField2: row.data.customField2,
        };
      }),
      skipDuplicates: true,
    });
  }

  // Re-read so we always work with real ids, including any that a concurrent
  // import just created.
  const persisted = await prisma.lead.findMany({
    where: { userId: session.sub, email: { in: wantedEmails } },
    select: { id: true, email: true },
  });
  const leadIds = persisted.map((l) => l.id);

  const link = group
    ? await addLeadsToGroup(group.id, leadIds)
    : { added: 0, alreadyPresent: 0 };

  const imported = missing.length;
  const duplicates = wantedEmails.length - imported;

  return jsonResponse({
    total: result.totalRows,
    imported,
    duplicates,
    invalid,
    // A row that is invalid is also "skipped" - kept for the old UI wording.
    skipped: invalid,
    addedToGroup: link.added,
    alreadyInGroup: link.alreadyPresent,
    group,
    message: group
      ? `${imported} new contact(s) imported, ${duplicates} existing contact(s) added to "${group.name}", ${invalid} skipped (invalid).`
      : `${imported} lead(s) imported, ${invalid} skipped (invalid).`,
  });
}
