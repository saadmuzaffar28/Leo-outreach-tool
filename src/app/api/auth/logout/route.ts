import { clearSessionCookie, getSession } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";

export async function POST() {
  const session = await getSession();
  if (session) clearSessionCookie();
  return jsonResponse({ ok: true });
}