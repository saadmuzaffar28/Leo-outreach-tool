// =============================================================================
// E2E harness: renders every page touched by the Groups feature with a real
// session, so runtime-only failures that a clean `next build` cannot catch are
// still caught.
//
//   $env:BASE_URL = "https://<your-tunnel-url>"
//   node tests/e2e/pages-render.mjs
//
// WARNING - creates and then deletes its own fixture group/leads, and its
// cleanup deletes leads ending in "@example.com". Do not run against a
// database with real @example.com contacts.
// =============================================================================
import "dotenv/config";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL;
const creds = Object.fromEntries(
  readFileSync(".admin-credentials.txt", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

let cookie = "";
const login = await fetch(BASE + "/api/auth/login", {
  method: "POST",
  headers: { Origin: BASE, "Content-Type": "application/json" },
  body: JSON.stringify({ email: creds.ADMIN_EMAIL, password: creds.ADMIN_PASSWORD }),
});
for (const c of login.headers.getSetCookie?.() ?? []) {
  const [kv] = c.split(";");
  if (kv) cookie = kv;
}
if (login.status !== 200) throw new Error("login failed: " + login.status);

const { PrismaClient } = await import("@prisma/client");
const p = new PrismaClient();
// Seed one group with two leads so the group view has real content to render.
const g = await p.group.create({ data: { userId: (await p.user.findFirst()).id, name: "Render Check", description: "e2e" } });
for (const email of ["r1.rendercheck@example.com", "r2.rendercheck@example.com"]) {
  const lead = await p.lead.create({ data: { userId: g.userId, firstName: "Render", lastName: "Check", email } });
  await p.leadGroup.create({ data: { groupId: g.id, leadId: lead.id } });
}
await p.$disconnect();

const pages = [
  ["/leads", "SMS Contacts", "/leads"],
  ["/leads?tab=email", "Email Leads", "/leads?tab=email"],
  ["/leads?tab=groups", "Groups", "/leads?tab=groups"],
  [`/leads?tab=email&group=${g.id}`, "Render Check", `/leads?tab=email&group=${g.id}`],
  [`/leads?tab=email&group=${g.id}&q=render`, "Render Check", "group search"],
  ["/leads?tab=email&group=does-not-exist", "Email Leads", "stale group id falls back"],
  ["/campaigns/new", "New campaign", "/campaigns/new"],
  ["/campaigns", "Campaigns", "/campaigns"],
  ["/templates", "Templates", "/templates"],
  ["/settings", "Settings", "/settings"],
  ["/dashboard", "Dashboard", "/dashboard"],
];

let failed = 0;
for (const [path, expect, label] of pages) {
  const res = await fetch(BASE + path, { headers: { Cookie: cookie }, redirect: "manual" });
  const html = await res.text();
  const ok = res.status === 200 && html.includes(expect);
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${path.padEnd(48)} HTTP ${res.status} ${label}`);
  if (!ok) {
    const m = html.match(/(?:Error|error)[:\s][^<]{0,160}/);
    console.log(`        ${m ? m[0].replace(/\s+/g, " ").slice(0, 160) : "expected text not found: " + expect}`);
  }
}

// Export must be group-scoped and carry a group-specific filename.
const exp = await fetch(BASE + `/api/leads/export?group=${g.id}`, { headers: { Cookie: cookie } });
const csv = await exp.text();
const disp = exp.headers.get("content-disposition") ?? "";
const csvOk = exp.status === 200 && /filename="group-render-check\.csv"/.test(disp) && csv.includes("r1.rendercheck@example.com") && !csv.includes("r3.");
console.log(`  ${csvOk ? "PASS" : "FAIL"}  group export  HTTP ${exp.status}  ${disp}`);
if (!csvOk) failed++;

const expAll = await fetch(BASE + "/api/leads/export", { headers: { Cookie: cookie } });
const dAll = expAll.headers.get("content-disposition") ?? "";
const allOk = expAll.status === 200 && dAll.includes("star-billing-leads.csv");
console.log(`  ${allOk ? "PASS" : "FAIL"}  all-contacts export unchanged  ${dAll}`);
if (!allOk) failed++;

// cleanup
{
  const p2 = new PrismaClient();
  await p2.leadGroup.deleteMany({ where: { groupId: g.id } });
  await p2.group.delete({ where: { id: g.id } });
  await p2.lead.deleteMany({ where: { email: { endsWith: "@example.com" } } });
  const left = await p2.group.count();
  await p2.$disconnect();
  const ok = left === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  cleanup: groups left=${left}`);
}

console.log(failed === 0 ? "\nALL PAGE RENDER CHECKS PASSED" : `\n${failed} PAGE CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
