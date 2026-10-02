import Papa from "papaparse";
import { z } from "zod";

/**
 * Accepted CSV headers, including aliases so common lead-export formats work:
 * a list with `Name, Company Name, Email, Phone` is accepted as-is.
 * Header names are case-insensitive and spaces are treated as underscores
 * (e.g. `Company Name` == `company_name`).
 */
export const SUPPORTED_CSV_COLUMNS = [
  "first_name",
  "last_name",
  "name",
  "full_name",
  "email",
  "practice_name",
  "company_name",
  "company",
  "phone",
  "custom_field_1",
  "custom_field_2",
] as const;

export type CsvLead = {
  firstName: string;
  lastName: string | null;
  email: string;
  practiceName: string | null;
  phone: string | null;
  customField1: string | null;
  customField2: string | null;
};

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface LeadCandidate {
  line: number;
  data: CsvLead;
  errors: ValidationIssue[];
  duplicate: boolean;
  duplicateOf?: string;
}

export interface CsvParseResult {
  candidates: LeadCandidate[];
  globalErrors: string[];
  totalRows: number;
}

const emailSchema = z.string().trim().toLowerCase().email();

/** Splits a full-name cell into first name + the rest as last name. */
function splitName(raw: string | null): { first: string | null; last: string | null } {
  if (!raw) return { first: null, last: null };
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") || null };
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, "_");
}

const cell = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
};

const KNOWN_HEADER_WEIGHTS: Record<string, number> = {
  email: 10,
  name: 8,
  full_name: 8,
  first_name: 7,
  last_name: 6,
  company_name: 6,
  company: 6,
  practice_name: 6,
  phone: 5,
  custom_field_1: 3,
  custom_field_2: 3,
};

/**
 * Quote-aware tokenizer for a single CSV line. Handles doubled quotes ("")
 * and delimiters inside quoted cells.
 */
function tokenizeCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

/** Picks the most likely delimiter (tab, comma, semicolon, pipe). */
function detectDelimiter(lines: string[]): string {
  const candidates = [",", "\t", ";", "|"];
  let best = ",";
  let bestScore = -1;
  for (const d of candidates) {
    let score = 0;
    for (const line of lines) {
      const count = line.split(d).length - 1;
      if (count > 0) score += count * 10 + 1; // volume + presence
    }
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * Tolerant CSV → record[] parser. Unlike strict CSV libraries it:
 * - skips leading/blank lines and a possible title row,
 * - auto-detects the delimiter,
 * - maps data rows to the detected header by position,
 * - never errors on row/header column-count mismatches
 *   (extra cells are folded into `extra_N`, missing cells become null).
 */
function parseCsvRecord(text: string): { records: Record<string, unknown>[]; lines: number[] } {
  const rawLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const nonEmpty: { line: number; text: string }[] = [];
  rawLines.forEach((l, i) => {
    if (l.trim().length > 0) nonEmpty.push({ line: i + 1, text: l.trim() });
  });

  if (nonEmpty.length === 0) return { records: [], lines: [] };

  const delimiter = detectDelimiter(nonEmpty.map((l) => l.text));
  const rows = nonEmpty.map((l) => tokenizeCsvLine(l.text, delimiter));

  // Find the header: the first row (within the top 5) that best matches known columns.
  let headerIndex = 0;
  let headerScore = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    let score = 0;
    for (const c of rows[i]) {
      const key = normalizeHeader(c);
      score += KNOWN_HEADER_WEIGHTS[key] ?? 0;
    }
    if (score > headerScore) {
      headerScore = score;
      headerIndex = i;
    }
  }

  const header = rows[headerIndex].map(normalizeHeader);
  const records: Record<string, unknown>[] = [];
  const lines: number[] = [];

  for (let r = headerIndex + 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 0 || (cells.length === 1 && cells[0] === "")) continue;
    const record: Record<string, unknown> = {};
    header.forEach((h, i) => {
      if (h) record[h] = cells[i] ?? null;
    });
    cells.slice(header.length).forEach((extra, i) => {
      record[`extra_${i}`] = extra;
    });
    records.push(record);
    lines.push(nonEmpty[r].line);
  }

  return { records, lines };
}

/**
 * Parses raw CSV text into validated lead candidates.
 * Pure function — no database access — so it is unit testable.
 */
export function parseCsv(text: string, existingEmails: string[] = []): CsvParseResult {
  const globalErrors: string[] = [];
  const { records: rawRows, lines } = parseCsvRecord(text);

  const candidates: LeadCandidate[] = [];
  const seen = new Set<string>(existingEmails.map((e) => e.toLowerCase()));

  rawRows.forEach((row, idx) => {
    const line = lines[idx] ?? idx + 2;
    const errors: ValidationIssue[] = [];
    const rawEmail = cell(row["email"]) ?? "";
    const email = rawEmail.toLowerCase();

    // Accept both the canonical columns and the `Name / Company Name` format.
    const explicitFirst = cell(row["first_name"]);
    const explicitLast = cell(row["last_name"]);
    const nameCell = cell(row["name"]) ?? cell(row["full_name"]);
    const { first, last } = splitName(nameCell);

    const firstName = explicitFirst ?? first;
    if (!firstName) {
      errors.push({
        path: "first_name",
        message: "Missing required field: first_name (or name)",
      });
    }

    const lastName = explicitLast ?? last;

    const emailCheck = emailSchema.safeParse(email);
    if (!emailCheck.success) {
      errors.push({ path: "email", message: "Invalid email format" });
    }

    let duplicate = false;
    if (emailCheck.success) {
      if (seen.has(email)) duplicate = true;
      seen.add(email);
    }

    candidates.push({
      line,
      data: {
        firstName: firstName ?? "",
        lastName,
        email: emailCheck.success ? email : email,
        practiceName:
          cell(row["practice_name"]) ?? cell(row["company_name"]) ?? cell(row["company"]),
        phone: cell(row["phone"]),
        customField1: cell(row["custom_field_1"]),
        customField2: cell(row["custom_field_2"]),
      },
      errors,
      duplicate,
      duplicateOf: duplicate ? email : undefined,
    });
  });

  return { candidates, globalErrors, totalRows: rawRows.length };
}

export function isUsable(entry: LeadCandidate): boolean {
  return entry.errors.length === 0 && !entry.duplicate;
}

/** Guards against CSV formula injection for cells starting with =,+,-,@ on export. */
export function guardCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s === "") return "";
  if (["=", "+", "-", "@"].includes(s[0])) return `'${s}`;
  return s;
}

export const EXPORT_COLUMNS = [
  "first_name",
  "last_name",
  "email",
  "practice_name",
  "phone",
  "custom_field_1",
  "custom_field_2",
] as const;

export interface ExportableLead {
  firstName: string;
  lastName: string | null;
  email: string;
  practiceName: string | null;
  phone: string | null;
  customField1: string | null;
  customField2: string | null;
}

/** Serializes leads to CSV with formula-injection protection. */
export function buildLeadsCsv(leads: ExportableLead[]): string {
  const rows = leads.map((l) => ({
    first_name: guardCell(l.firstName),
    last_name: guardCell(l.lastName),
    email: guardCell(l.email),
    practice_name: guardCell(l.practiceName),
    phone: guardCell(l.phone),
    custom_field_1: guardCell(l.customField1),
    custom_field_2: guardCell(l.customField2),
  }));
  return Papa.unparse(rows, { header: true });
}