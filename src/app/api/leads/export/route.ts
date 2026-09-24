import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { buildLeadsCsv } from "@/lib/csv";
import { forbidden } from "@/lib/http";

export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();

  const leads = await prisma.lead.findMany({
    where: { userId: session.sub },
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

  const sanitized = "star-billing-leads.csv";
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${sanitized}"`,
    },
  });
}