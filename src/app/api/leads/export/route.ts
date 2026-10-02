import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { buildLeadsCsv } from "@/lib/csv";
import { groupLeadWhere } from "@/lib/groups";
import { forbidden, notFound } from "@/lib/http";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return forbidden();

  // `?group=<id>` exports just that group's contacts; no param exports all.
  const groupId = new URL(req.url).searchParams.get("group")?.trim() || null;

  let filename = "star-billing-leads.csv";
  if (groupId) {
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group || group.userId !== session.sub) return notFound("Group not found");
    // Keep the filename filesystem-safe while preserving the readable name.
    const safe = group.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
    filename = `group-${safe || "contacts"}.csv`;
  }

  const leads = await prisma.lead.findMany({
    where: groupLeadWhere(session.sub, groupId),
    orderBy: { createdAt: "desc" },
  });

  const csv = buildLeadsCsv(
    leads.map((l) => ({
      firstName: l.firstName,
      lastName: l.lastName,
      email: l.email,
      practiceName: l.practiceName,
      phone: l.phone,
      customField1: l.customField1,
      customField2: l.customField2,
    })),
  );

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}