import { getSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { verificationBulkSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, forbidden, jsonResponse } from "@/lib/http";
import { parseEmailList } from "@/lib/verification/normalize";
import { enqueueVerifications, type EnqueueOutcome } from "@/lib/verification/service";

export const runtime = "nodejs";

/**
 * POST /api/email-verification/bulk
 * Body: { emails?: string[], csv?: string, force?: boolean }
 *
 * Queues background verification jobs — NEVER verifies synchronously.
 * Flow: parse → normalize/dedupe → queue → worker → store (Phase 8).
 */
export async function POST(req: Request) {
  if (!assertSameOrigin(req)) return forbidden();
  const session = await getSession();
  if (!session) return forbidden();

  if (!env.EMAIL_VERIFICATION_ENABLED) {
    return badRequest("Email verification is disabled (EMAIL_VERIFICATION_ENABLED=false)");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const parsed = verificationBulkSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid request");

  // Normalize both input shapes into one list, with request-level dedupe.
  const raw: string[] = [];
  let csvInvalid = 0;
  let csvDuplicates = 0;
  if (parsed.data.csv) {
    const fromCsv = parseEmailList(parsed.data.csv);
    raw.push(...fromCsv.emails);
    csvInvalid = fromCsv.invalid;
    csvDuplicates = fromCsv.duplicates;
  }
  if (parsed.data.emails) raw.push(...parsed.data.emails);

  const outcome: EnqueueOutcome = await enqueueVerifications(session.sub, raw, {
    force: parsed.data.force === true,
  });
  outcome.invalidFormat += csvInvalid;
  outcome.duplicates += csvDuplicates;

  return jsonResponse({ ok: true, ...outcome }, outcome.queued > 0 ? 201 : 200);
}
