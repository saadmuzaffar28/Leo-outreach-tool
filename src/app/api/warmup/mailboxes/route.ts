import { getSession } from "@/lib/auth";
import { forbidden, jsonResponse } from "@/lib/http";
import { listWarmupMailboxes } from "@/lib/warmup/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/warmup/mailboxes — every SMTP mailbox with its warm-up state.
 *
 * SECURITY: this view deliberately contains no credential fields of any kind —
 * not SMTP, not IMAP, not even the encrypted blobs. It reports only whether
 * IMAP is configured and whether it currently authenticates.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return forbidden();

  const mailboxes = await listWarmupMailboxes(session.sub);
  return jsonResponse({ mailboxes });
}