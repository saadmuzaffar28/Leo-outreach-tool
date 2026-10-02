import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { parseCsv } from "@/lib/csv";
import { assertSameOrigin, badRequest, forbidden, jsonResponse } from "@/lib/http";

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
  const csv = (body as { csv?: string })?.csv;
  if (typeof csv !== "string" || csv.length > 5_000_000) {
    return badRequest("CSV content is missing or too large (max 5MB)");
  }

  const existing = await prisma.lead.findMany({
    where: { userId: session.sub },
    select: { email: true },
  });
  const existingEmails = existing.map((l) => l.email.toLowerCase());

  const result = parseCsv(csv, existingEmails);

  const rows = result.candidates.map((c) => ({
    line: c.line,
    firstName: c.data.firstName,
    lastName: c.data.lastName,
    email: c.data.email,
    practiceName: c.data.practiceName,
    phone: c.data.phone,
    customField1: c.data.customField1,
    customField2: c.data.customField2,
    errors: c.errors,
    duplicate: c.duplicate,
    duplicateOf: c.duplicateOf ?? null,
    usable: c.errors.length === 0 && !c.duplicate,
  }));

  const counts = {
    total: result.totalRows,
    valid: rows.filter((r) => r.usable).length,
    errors: result.candidates.filter((c) => c.errors.length > 0).length,
    duplicates: result.candidates.filter((c) => c.duplicate).length,
  };

  return jsonResponse({ rows: rows.slice(0, 200), counts, globalErrors: result.globalErrors });
}