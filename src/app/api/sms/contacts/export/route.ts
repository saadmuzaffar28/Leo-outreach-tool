import Papa from "papaparse";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { forbidden } from "@/lib/http";
import { guardCell } from "@/lib/csv";

export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();

  const contacts = await prisma.contact.findMany({
    where: { userId: session.sub },
    orderBy: { createdAt: "desc" },
  });

  const rows = contacts.map((c) => ({
    name: guardCell(c.name),
    // E.164 numbers cannot be formulas — export them unquoted.
    phone_number: /^\+?\d[\d\s().-]*$/.test(c.phoneNumber) ? c.phoneNumber : guardCell(c.phoneNumber),
    opt_out: c.optOut ? "true" : "false",
    status: guardCell(c.status),
    created_at: c.createdAt.toISOString(),
  }));

  return new Response(Papa.unparse(rows, { header: true }), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sms-contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
