import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { parseCsv, type LeadCandidate } from "@/lib/csv";
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
  const usable = result.candidates.filter(
    (c: LeadCandidate) => c.errors.length === 0 && !c.duplicate,
  );

  if (usable.length > 0) {
    await prisma.lead.createMany({
      data: usable.map((c) => ({
        userId: session.sub,
        firstName: c.data.firstName,
        lastName: c.data.lastName,
        email: c.data.email,
        practiceName: c.data.practiceName,
        phone: c.data.phone,
        customField1: c.data.customField1,
        customField2: c.data.customField2,
      })),
      skipDuplicates: true,
    });
  }

  const counted = {
    total: result.totalRows,
    imported: usable.length,
    skipped: result.totalRows - usable.length,
  };

  return jsonResponse({
    ...counted,
    globalErrors: result.globalErrors,
    message: `${counted.imported} lead(s) imported, ${counted.skipped} skipped (duplicates or invalid).`,
  });
}