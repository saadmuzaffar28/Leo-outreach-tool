import { getSession } from "@/lib/auth";
import { forbidden, notFound } from "@/lib/http";
import { guardCell } from "@/lib/csv";
import { getOwnedBatch } from "@/lib/verification/batch";
import { listVerifications } from "@/lib/verification/service";

export const runtime = "nodejs";

const COLUMNS = [
  "email",
  "status",
  "confidence",
  "syntaxValid",
  "domainValid",
  "mxValid",
  "smtpReachable",
  "catchAll",
  "disposable",
  "roleAccount",
  "freeProvider",
  "typoSuggestion",
  "errorCode",
  "errorMessage",
  "provider",
  "verificationVersion",
  "checkedAt",
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  // guardCell neutralises spreadsheet formula injection (=, +, -, @).
  return guardCell(String(value));
}

/**
 * GET /api/email-verification/export?status=&q=&batchId=
 * Full CSV export of the session user's verification results. With a
 * batchId it exports that batch's addresses only — ownership is checked
 * first, so someone else's batch 404s instead of leaking.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return forbidden();

  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const q = url.searchParams.get("q") ?? undefined;
  const batchId = url.searchParams.get("batchId") ?? undefined;

  if (batchId) {
    const batch = await getOwnedBatch(session.sub, batchId);
    if (!batch) return notFound("Batch not found");
  }

  // Page through the full result set (500 rows/query, up to 10k rows) so a
  // large verified list exports completely rather than silently truncating.
  const rows = [];
  const PAGE = 500;
  const MAX_ROWS = 10_000;
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const page = await listVerifications(session.sub, { status, q, batchId, limit: PAGE, offset });
    rows.push(...page.rows);
    if (rows.length >= page.total) break;
  }

  const lines = [COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.email,
        row.status,
        row.confidence,
        row.syntaxValid,
        row.domainValid,
        row.mxValid,
        row.smtpReachable,
        row.catchAll,
        row.disposable,
        row.roleAccount,
        row.freeProvider,
        row.typoSuggestion,
        row.errorCode,
        row.errorMessage,
        row.provider,
        row.verificationVersion,
        row.checkedAt.toISOString(),
      ]
        .map(csvCell)
        .join(","),
    );
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(`${lines.join("\r\n")}\r\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="verified-leads-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
