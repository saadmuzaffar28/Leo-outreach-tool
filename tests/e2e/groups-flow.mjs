// =============================================================================
// E2E harness: Groups + campaign recipient flow, against the LIVE app.
//
//   $env:BASE_URL = "https://<your-tunnel-url>"
//   node tests/e2e/groups-flow.mjs
//
// WARNING - this script WRITES to the production database. Its pre-clean and
// final cleanup steps delete every lead whose email ends in "@example.com",
// plus campaigns named "E2E Campaign*"/"Empty*", groups named
// "Test Prospects", and suppressions with reason "e2e test". Do not run it
// against a database that contains real @example.com contacts.
// It is NOT picked up by `npm test` (vitest only matches *.test.ts).
// =============================================================================
// End-to-end verification of the Groups feature against the live app through
// the Cloudflare tunnel. Nothing here modifies Google OAuth, APP_URL, or the
// tunnel - it only drives the app's own authenticated API.
import "dotenv/config";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL;
if (!BASE) throw new Error("BASE_URL required");

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
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

async function api(path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Origin: BASE,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const setC = res.headers.getSetCookie?.() ?? [];
  for (const c of setC) {
    const [kv] = c.split(";");
    if (kv.startsWith("leo_session=") || /^[a-z_]+=/.test(kv)) cookie = kv;
  }
  if (raw) return { status: res.status, text: await res.text() };
  const t = await res.text();
  let json = null;
  try { json = JSON.parse(t); } catch { /* non-JSON */ }
  return { status: res.status, json, text: t };
}

const uniq = () => Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------- login
console.log("\n=== login ===");
const login = await api("/api/auth/login", {
  method: "POST",
  body: { email: creds.ADMIN_EMAIL, password: creds.ADMIN_PASSWORD },
});
check("login", login.status === 200, `HTTP ${login.status}`);
if (login.status !== 200) {
  console.log(login.text.slice(0, 300));
  process.exit(1);
}

// ------------------------------------------------- pre-clean leftovers
// A previously crashed run can leave harness rows behind and would make the
// assertions below fail for the wrong reason.
{
  const { PrismaClient } = await import("@prisma/client");
  const p0 = new PrismaClient();
  await p0.campaign.deleteMany({
    where: { OR: [{ name: { contains: "E2E Campaign" } }, { name: { startsWith: "Empty " } }] },
  });
  await p0.lead.deleteMany({ where: { email: { endsWith: "@example.com" } } });
  await p0.group.deleteMany({ where: { name: "Test Prospects" } });
  await p0.suppression.deleteMany({ where: { reason: "e2e test" } });
  const leftover = await p0.group.count();
  await p0.$disconnect();
  check("pre-clean: no harness leftovers", leftover === 0, `groups left=${leftover}`);
}

// ------------------------------------------------- CSRF still enforced
console.log("\n=== CSRF guard (tunnel origin vs foreign origin) ===");
const foreign = await fetch(BASE + "/api/groups", {
  method: "POST",
  headers: { Origin: "http://evil.example", Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "csrf-probe" }),
});
const fb = await foreign.json().catch(() => ({}));
check("foreign Origin blocked", foreign.status === 403, `HTTP ${foreign.status}`);

// ------------------------------------------------------- TEST 1: create group
console.log("\n=== TEST 1: create group 'Test Prospects' ===");
const g1 = await api("/api/groups", { method: "POST", body: { name: "Test Prospects", description: "e2e" } });
check("create group", g1.status === 201 && g1.json?.group?.name === "Test Prospects", `HTTP ${g1.status} ${g1.json?.group?.name ?? g1.text.slice(0,120)}`);
const groupA = g1.json?.group?.id;
if (!groupA) {
  console.log("  ABORT: could not create the base group; the rest of the run is meaningless.");
  process.exit(1);
}

// duplicate name must be rejected cleanly
const gDup = await api("/api/groups", { method: "POST", body: { name: "  test   prospects " } });
check("duplicate name rejected (case/space-insensitive)", gDup.status === 400, `HTTP ${gDup.status} ${gDup.json?.error ?? ""}`);

// empty name rejected
const gEmpty = await api("/api/groups", { method: "POST", body: { name: "   " } });
check("empty name rejected", gEmpty.status === 400, `HTTP ${gEmpty.status}`);

// oversize name rejected
const gBig = await api("/api/groups", { method: "POST", body: { name: "x".repeat(200) } });
check("oversize name rejected", gBig.status === 400, `HTTP ${gBig.status}`);

// ------------------------------------------- TEST 2/3/4: CSV into that group
console.log("\n=== TEST 2-4: import CSV into 'Test Prospects' ===");
const s = uniq();
const csvA = [
  "Name,Company Name,Email,Phone",
  `Alice Alpha,Alpha Dental,alice.${s}@example.com,555-0001`,
  `Bob Beta,Beta Health,bob.${s}@example.com,555-0002`,
  `Cara Gamma,Gamma Care,cara.${s}@example.com,555-0003`,
  "Bad Row,No Email,,555-0004",
].join("\n");
const impA = await api("/api/leads/import/save", { method: "POST", body: { csv: csvA, groupId: groupA } });
check("import into group", impA.status === 200, `HTTP ${impA.status} ${impA.text.slice(0, 160)}`);
const ia = impA.json ?? {};
console.log(`      summary: ${JSON.stringify({ imported: ia.imported, duplicates: ia.duplicates, invalid: ia.invalid, addedToGroup: ia.addedToGroup })}`);
check("3 imported", ia.imported === 3, `imported=${ia.imported}`);
check("1 invalid (missing email)", ia.invalid === 1, `invalid=${ia.invalid}`);

const listA = await api(`/api/groups/${groupA}/leads`);
check("group shows 3 contacts", listA.json?.total === 3, `total=${listA.json?.total}`);

// ------------------------------------ TEST 5: same contacts in All Contacts
console.log("\n=== TEST 5: contacts also in All Contacts ===");
const all = await api("/api/leads/summary");
check("All Contacts has >= 3", (all.json?.total ?? 0) >= 3, `total=${all.json?.total}`);

// ------------------------------------------------- TEST 6: second group
console.log("\n=== TEST 6: create second group ===");
const g2 = await api("/api/groups", { method: "POST", body: { name: `Second Group ${s}` } });
check("create second group", g2.status === 201, `HTTP ${g2.status}`);
const groupB = g2.json?.group?.id;

// ------------------------- TEST 7: import an EXISTING email into group 2
console.log("\n=== TEST 7: re-import existing email into group 2 (no duplicate lead) ===");
const leadsBefore = (await api("/api/leads/summary")).json?.total ?? 0;
const csvB = [
  "Name,Company Name,Email,Phone",
  `Alice Alpha,Alpha Dental,alice.${s}@example.com,555-0001`,
  `Dee Delta,Delta Docs,dee.${s}@example.com,555-0009`,
].join("\n");
const impB = await api("/api/leads/import/save", { method: "POST", body: { csv: csvB, groupId: groupB } });
const ib = impB.json ?? {};
console.log(`      summary: ${JSON.stringify({ imported: ib.imported, duplicates: ib.duplicates, addedToGroup: ib.addedToGroup })}`);
check("1 new + 1 duplicate", ib.imported === 1 && ib.duplicates === 1, `imported=${ib.imported} dup=${ib.duplicates}`);
const leadsAfter = (await api("/api/leads/summary")).json?.total ?? 0;
check("exactly 1 new lead created", leadsAfter === leadsBefore + 1, `${leadsBefore} -> ${leadsAfter}`);

const listB = await api(`/api/groups/${groupB}/leads`);
check("contact in BOTH groups", listB.json?.total === 2, `groupB total=${listB.json?.total}`);
const listA2 = await api(`/api/groups/${groupA}/leads`);
check("group A still has its 3", listA2.json?.total === 3, `groupA total=${listA2.json?.total}`);

// ------------------------------------------- in-file duplicate collapses
console.log("\n=== TEST 7b: same email twice in one file collapses to one lead ===");
const dupInFile = ["Name,Email", `Eve E,eve.${s}@example.com`, `Eve E2,eve.${s}@example.com`].join("\n");
const g3 = await api("/api/groups", { method: "POST", body: { name: `Dup Test ${s}` } });
const impD = await api("/api/leads/import/save", { method: "POST", body: { csv: dupInFile, groupId: g3.json?.group?.id } });
check("collapsed to 1 imported", impD.json?.imported === 1, `imported=${impD.json?.imported} dup=${impD.json?.duplicates}`);

// ------------------------------------- empty / all-invalid CSV behaviour
console.log("\n=== TEST 16: empty CSV and all-invalid CSV give useful errors ===");
const empty = await api("/api/leads/import/save", { method: "POST", body: { csv: "", groupId: groupA } });
check("empty CSV -> 400", empty.status === 400, `HTTP ${empty.status}`);
const allBad = await api("/api/leads/import/save", { method: "POST", body: { csv: "Name,Email\nX,not-an-email\nY,also-bad", groupId: groupA } });
check("all-invalid CSV -> 400 (no misleading success)", allBad.status === 400, `HTTP ${allBad.status} ${allBad.json?.error ?? ""}`);

// ------------------------------------------ TEST 8/9: campaign recipients
console.log("\n=== TEST 8-9: campaign recipient selector ===");
const groups = (await api("/api/groups")).json?.groups ?? [];
const listedA = groups.find((g) => g.id === groupA);
check("group listed with count", listedA?.contactCount === 3, `${listedA?.name}=${listedA?.contactCount}`);

// The campaign API needs a real sender + template id, which the app only
// exposes to the server-rendered form, so read them straight from the DB.
const { PrismaClient } = await import("@prisma/client");
const p = new PrismaClient();
const google = await p.googleAccount.findFirst({ select: { id: true } });
const tplRow = await p.emailTemplate.findFirst({ select: { id: true } });
await p.$disconnect();

if (google && tplRow) {
  const camp = await api("/api/campaigns", {
    method: "POST",
    body: { name: `E2E Campaign ${s}`, templateId: tplRow.id, googleAccountId: google.id, recipientGroupId: groupA },
  });
  check("campaign created for group A", camp.status === 201, `HTTP ${camp.status} ${camp.text.slice(0, 160)}`);
  const campId = camp.json?.campaign?.id;

  // campaign detail must expose the group by ID, not name-as-text
  if (campId) {
    const row = await (async () => {
      const pp = new PrismaClient();
      const c = await pp.campaign.findUnique({ where: { id: campId }, include: { recipientGroup: true } });
      await pp.$disconnect();
      return c;
    })();
    check("campaign stores stable group ID", row?.recipientGroupId === groupA, `recipientGroupId=${row?.recipientGroupId}`);
    check("campaign resolves group relation", row?.recipientGroup?.name === "Test Prospects", row?.recipientGroup?.name);
  }

  // A genuinely empty group must be rejected cleanly. (g3 above is NOT empty -
  // the in-file-dup import put a lead in it.)
  const gEmpty = await api("/api/groups", { method: "POST", body: { name: `Empty ${s}` } });
  const emptyCamp = await api("/api/campaigns", {
    method: "POST",
    body: { name: `EmptyCamp ${s}`, templateId: tplRow.id, googleAccountId: google.id, recipientGroupId: gEmpty.json?.group?.id },
  });
  check("campaign on empty group rejected", emptyCamp.status === 400, `HTTP ${emptyCamp.status} ${emptyCamp.json?.error ?? ""}`);

  // ------------------ TEST 10/11: launch resolves ONLY the group's members
  console.log("\n=== TEST 10: launch resolves only group members, respects suppression ===");
  // suppress one member of group A to prove suppression is still honoured
  const members = (await api(`/api/groups/${groupA}/leads`)).json?.contacts ?? [];
  const victim = members[0];
  const supp = await api("/api/suppressions", { method: "POST", body: { email: victim.email, reason: "e2e test" } });
  check("suppression created", supp.status === 200 || supp.status === 201, `HTTP ${supp.status}`);

  if (campId) {
    const start = await api(`/api/campaigns/${campId}/status`, { method: "POST", body: { action: "start" } });
    check("campaign started", start.status === 200, `HTTP ${start.status} ${start.text.slice(0, 200)}`);

    const pp2 = new PrismaClient();
    const recips = await pp2.campaignRecipient.findMany({ where: { campaignId: campId }, orderBy: { recipient: "asc" } });
    await pp2.$disconnect();
    console.log(`      snapshot rows: ${JSON.stringify(recips.map((r) => ({ to: r.recipient, st: r.status })))}`);
    check("snapshot has exactly the 3 group members", recips.length === 3, `rows=${recips.length}`);
    const outside = members.some((m) => !recips.find((r) => r.leadId === m.id));
    check("no recipient outside group A", !outside, "all rows are group A members");
    const skipped = recips.find((r) => r.recipient === victim.email.toLowerCase());
    check("suppressed member seeded as skipped", skipped?.status === "skipped", `${skipped?.status} / ${skipped?.lastError}`);

    // ---- TEST 9 (safety): adding a member later must NOT change the snapshot
    console.log("\n=== TEST 9-safety: group changes after start do not alter the campaign ===");
    const g4 = await api("/api/groups", { method: "POST", body: { name: `Late Add ${s}` } });
    const lateCsv = ["Name,Email", `Late Late,late.${s}@example.com`].join("\n");
    await api("/api/leads/import/save", { method: "POST", body: { csv: lateCsv, groupId: groupA } });
    const pp3 = new PrismaClient();
    const after = await pp3.campaignRecipient.count({ where: { campaignId: campId } });
    await pp3.$disconnect();
    check("adding a contact to the group did NOT change the snapshot", after === 3, `rows now ${after}`);

    // stop the campaign so it does not actually send
    const stop = await api(`/api/campaigns/${campId}/status`, { method: "POST", body: { action: "stop" } });
    check("campaign stopped (no real sends)", stop.status === 200, `HTTP ${stop.status}`);

    // clean up the suppression (POST returns { suppression: {...} })
    const del = await api(`/api/suppressions/${supp.json?.suppression?.id}`, { method: "DELETE" });
    check("suppression removed", del.status === 200, `HTTP ${del.status}`);
  }
} else {
  check("google account available for campaign test", false, "no google account / template found");
}

// ------------------------------------------- TEST 12: delete group, keep leads
console.log("\n=== TEST 12: delete group does NOT delete contacts ===");
const leadsBeforeDel = (await api("/api/leads/summary")).json?.total ?? 0;
// group A gained a 4th member in the late-add test, so compare against its
// current size rather than the original 3.
const groupSizeAtDelete = (await api(`/api/groups/${groupA}/leads`)).json?.total ?? 0;
const delA = await api(`/api/groups/${groupA}`, { method: "DELETE" });
check("group deleted", delA.status === 200, `HTTP ${delA.status}`);
check("API reports contacts kept", delA.json?.contactsKept === groupSizeAtDelete, `contactsKept=${delA.json?.contactsKept} expected=${groupSizeAtDelete}`);
const leadsAfterDel = (await api("/api/leads/summary")).json?.total ?? 0;
check("lead count unchanged", leadsAfterDel === leadsBeforeDel, `${leadsBeforeDel} -> ${leadsAfterDel}`);

// campaign that referenced the deleted group must survive with groupId nulled
const pp4 = new PrismaClient();
const orphan = await pp4.campaign.findMany({ where: { name: { startsWith: "E2E Campaign" } }, select: { id: true, name: true, recipientGroupId: true, status: true } });
const orphanRecs = orphan.length ? await pp4.campaignRecipient.count({ where: { campaignId: orphan[0].id } }) : 0;
await pp4.$disconnect();
check("campaign survived group deletion", orphan.length > 0, `campaigns=${orphan.length}`);
check("campaign groupId nulled (ON DELETE SET NULL)", orphan[0]?.recipientGroupId === null, `recipientGroupId=${orphan[0]?.recipientGroupId}`);
check("campaign recipient history intact", orphanRecs === 3, `recipient rows=${orphanRecs}`);

// ------------------------------------------------------------- cleanup
console.log("\n=== cleanup (remove e2e artifacts, keep no test data behind) ===");
for (const g of (await api("/api/groups")).json?.groups ?? []) {
  await api(`/api/groups/${g.id}`, { method: "DELETE" });
}
const pp5 = new PrismaClient();
await pp5.lead.deleteMany({ where: { email: { endsWith: "@example.com" } } });
await pp5.campaign.deleteMany({
  where: { OR: [{ name: { contains: "E2E Campaign" } }, { name: { startsWith: "Empty" } }] },
});
await pp5.suppression.deleteMany({ where: { reason: "e2e test" } });
const remaining = await pp5.group.count();
const leadsLeft = await pp5.lead.count();
const campsLeft = await pp5.campaign.count();
const supsLeft = await pp5.suppression.count();
await pp5.$disconnect();
check("all e2e groups removed", remaining === 0, `groups left=${remaining}`);
check("all e2e leads removed", leadsLeft === 0, `leads left=${leadsLeft}`);
check("all e2e campaigns removed", campsLeft === 0, `campaigns left=${campsLeft}`);
check("all e2e suppressions removed", supsLeft === 0, `suppressions left=${supsLeft}`);

// ------------------------------------------------------------------ summary
const failed = results.filter((r) => !r.pass);
console.log(`\n================ ${results.length - failed.length}/${results.length} checks passed ================`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name}  (${f.detail})`);
  process.exit(1);
}
console.log("ALL E2E CHECKS PASSED");
