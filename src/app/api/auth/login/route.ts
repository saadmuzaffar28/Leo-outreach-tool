import { prisma } from "@/lib/prisma";
import {
  createSessionToken,
  setSessionCookie,
  verifyPassword,
} from "@/lib/auth";
import { loginSchema } from "@/lib/validation";
import { assertSameOrigin, badRequest, jsonResponse, unauthorized } from "@/lib/http";

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) return unauthorized("Cross-origin request blocked");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  const email = parsed.data.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return unauthorized("Invalid email or password");

  const ok = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!ok) return unauthorized("Invalid email or password");

  const token = await createSessionToken({
    sub: user.id,
    email: user.email,
    name: user.name,
  });
  setSessionCookie(token);

  return jsonResponse({ ok: true, email: user.email });
}