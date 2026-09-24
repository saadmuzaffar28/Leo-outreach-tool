import Papa from "papaparse";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { assertSameOrigin, badRequest, forbidden, jsonResponse } from "@/lib/http";
import { isValidPhoneNumber, normalizePhoneNumber } from "@/lib/8x8";

interface ImportRow {
  name?: string;
  full_name?: string;
  phone?: string;
  phone_number?: string;
  opt_out?: string;
}

/**
 * CSV import for SMS contacts. Accepted headers (case-insensitive):
 * name / full_name, phone / phone_number, opt_out (optional true/false).
 */
export async function POST(req: Request) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  let csv = "";
  try {
    const body = (await req.json()) as { csv?: string };
    csv = typeof body.csv === "string" ? body.csv : "";
  } catch {
    return badRequest("Invalid JSON body");
  }
  if (!csv.trim()) return badRequest("CSV content is required");
  if (csv.length > 2_000_000) return badRequest("CSV too large (max ~2MB)");

  const parsed = Papa.parse<ImportRow>(csv.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
  });

  const rows = parsed.data ?? [];
  if (rows.length === 0) return badRequest("No data rows found in CSV");

  let imported = 0;
  let updated = 0;
  const errors: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = (row.name ?? row.full_name ?? "").trim();
    const rawPhone = (row.phone ?? row.phone_number ?? "").trim();

    if (!name || !rawPhone) {
      errors.push(`Row ${i + 2}: missing name or phone`);
      continue;
    }
    const phoneNumber = normalizePhoneNumber(rawPhone);
    if (!isValidPhoneNumber(phoneNumber)) {
      errors.push(`Row ${i + 2}: invalid phone number "${rawPhone}"`);
      continue;
    }
    if (seen.has(phoneNumber)) continue;
    seen.add(phoneNumber);

    const optOut = /^(true|1|yes)$/i.test((row.opt_out ?? "").trim());

    const existing = await prisma.contact.findFirst({
      where: { userId: session.sub, phoneNumber },
      select: { id: true },
    });
    if (existing) {
      await prisma.contact.update({
        where: { id: existing.id },
        data: { name, ...(row.opt_out !== undefined ? { optOut } : {}) },
      });
      updated++;
    } else {
      await prisma.contact.create({
        data: { userId: session.sub, name, phoneNumber, optOut, status: optOut ? "opted_out" : "active" },
      });
      imported++;
    }
  }

  return jsonResponse({ imported, updated, failed: errors.length, errors: errors.slice(0, 20) });
}
