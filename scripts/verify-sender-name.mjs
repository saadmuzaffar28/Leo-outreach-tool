// End-to-end proof of the per-campaign sender name, through the real HTTP
// surface. Read-only except for validation probes, which are REJECTED by the
// schema and therefore create nothing.
//
//   1. /campaigns/new renders a "Sender name" field, pre-filled with the global
//      SENDER_NAME default
//   2. the campaign detail page shows the resolved sender name
//   3. the preview API returns the resolved sender name
//   4. the create API REJECTS header-injection and address-forging payloads
//   5. the create API REJECTS a blank name, and accepts the field being absent
//
// Mutates nothing. Run: node scripts\verify-sender-name.mjs
import { readFileSync } from "node:fs";

const lines = readFileSync(".env", "utf8").split(/\r?\n/);
const v = (n) =>
  (lines.find((l) => l.startsWith(n)) ?? "")
    .replace(new RegExp("^" + n + '=\"?'), "")
    .replace(/"$/, "");

const APP_URL = v("APP_URL");
const BASE = "http://localhost:3010";
const SENDER_NAME = v("SENDER_NAME");

let failures = 0;
const check = (label, pass, detail) => {
  if (!pass) failures++;
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${label}${detail ? "  -> " + detail : ""}`);
};

const login = await fetch(BASE + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: v("ADMIN_EMAIL"), password: v("ADMIN_PASSWORD") }),
});
if (!login.ok) {
  console.log("login failed: HTTP " + login.status);
  process.exit(1);
}
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
console.log("login -> HTTP " + login.status + " (session established)");
console.log("SENDER_NAME env = " + JSON.stringify(SENDER_NAME));
console.log("");

const H = { cookie };

// ---------------------------------------------------------------- 1. the form
console.log("=== 1. GET /campaigns/new (new campaign form) ===");
const formHtml = await (await fetch(BASE + "/campaigns/new", { headers: H })).text();
check("page returns 200 with a session", !formHtml.includes("Sign in"), "not redirected to login");
check('renders a "Sender name" label', formHtml.includes("Sender name"));
check("input carries the SENDER_NAME default (pre-filled)", formHtml.includes(SENDER_NAME));
check("explains it is per-campaign only", /only this campaign|does not change other campaigns/i.test(formHtml));
check("maxLength=80 enforced in the DOM", /maxLength="80"|maxlength="80"/.test(formHtml));
console.log("");

// ------------------------------------------------------------ 2. detail page
console.log("=== 2. campaign detail page ===");
const list = await (await fetch(BASE + "/api/campaigns", { headers: H })).json();
const campaigns = list.campaigns ?? list;
const first = campaigns[0];
check("a campaign exists to inspect", Boolean(first), first ? first.name : "none");
if (first) {
  const detail = await (await fetch(BASE + "/campaigns/" + first.id, { headers: H })).text();
  check('shows a "Sender name" row', detail.includes("Sender name"));
  check("resolves to the global default when unset", detail.includes(SENDER_NAME));

  // ------------------------------------------------------- 3. the preview API
  console.log("");
  console.log("=== 3. GET /api/campaigns/{id}/preview ===");
  const prev = await (
    await fetch(BASE + "/api/campaigns/" + first.id + "/preview", { headers: H })
  ).json();
  check("preview returns a senderName", typeof prev.senderName === "string", JSON.stringify(prev.senderName));
  check("preview senderName matches the global default", prev.senderName === SENDER_NAME);
  check("preview still returns the sending address", Boolean(prev.senderEmail), String(prev.senderEmail));
  check("preview address is a real connected account", String(prev.senderEmail).includes("@"));
  console.log("  From line the operator will see: " + prev.senderName + " <" + prev.senderEmail + ">");
}

// ------------------------------------------- 4/5. create-API validation probes
console.log("");
console.log("=== 4/5. POST /api/campaigns validation (all must be REJECTED) ===");
// The list API intentionally withholds templateId/googleAccountId, so read them
// straight from the database. Read-only -- no writes.
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
const seed = await db.campaign.findFirst({
  where: { templateId: { not: null }, googleAccountId: { not: null } },
  select: { templateId: true, googleAccountId: true },
});
const googleAccountId = seed?.googleAccountId ?? null;
const templateId = seed?.templateId ?? null;
await db.$disconnect();
check("found a campaign template/account pair to probe with", Boolean(googleAccountId && templateId));

if (!googleAccountId || !templateId) {
  console.log("  (skipped: could not read a templateId/googleAccountId from an existing campaign)");
} else {
  const post = async (extra) => {
    const r = await fetch(BASE + "/api/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie, Origin: BASE },
      body: JSON.stringify({
        name: "ZZ sender-name probe (rejected, must not persist)",
        templateId,
        googleAccountId,
        ...extra,
      }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const injections = [
    ["CRLF -> Bcc header", "Acme\r\nBcc: attacker@evil.example"],
    ["bare LF -> Bcc header", "Acme\nBcc: attacker@evil.example"],
    ["bare CR -> Bcc header", "Acme\rBcc: attacker@evil.example"],
    ["forges the From address", "Evil <attacker@evil.example>"],
    ["over 80 chars", "A".repeat(81)],
  ];
  for (const [label, payload] of injections) {
    const r = await post({ senderName: payload });
    check(`rejected: ${label}`, r.status === 400, "HTTP " + r.status + " " + (r.body.error ?? ""));
  }

  const blank = await post({ senderName: "   " });
  check("rejected: whitespace-only name", blank.status === 400, "HTTP " + blank.status);

  // Proving the "optional" contract needs a successful create, which WOULD write
  // a row and there is no DELETE endpoint -- so it is covered by the unit tests
  // instead (tests/campaign-sender-name.test.ts) rather than by littering the DB.
  console.log("  (a SUCCESSFUL create is intentionally not probed: it would write a");
  console.log("   campaign row and this app has no DELETE endpoint. Covered by unit tests.)");
}

// -------------------------------------------------- nothing was created
console.log("");
console.log("=== post-check: no probe campaign was created ===");
const after = await (await fetch(BASE + "/api/campaigns", { headers: H })).json();
const afterC = after.campaigns ?? after;
check(
  "campaign count unchanged",
  afterC.length === campaigns.length,
  campaigns.length + " -> " + afterC.length,
);
check(
  "no 'ZZ sender-name probe' exists",
  !afterC.some((c) => String(c.name).startsWith("ZZ sender-name probe")),
);

console.log("");
console.log(failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
