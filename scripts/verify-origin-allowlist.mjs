// Verifies the ALLOWED_ORIGINS change end to end, without mutating anything.
//   - localhost Origin (what the user's browser sends) must now be ACCEPTED
//   - APP_URL Origin must still be accepted (no regression)
//   - a hostile/foreign origin must still be REJECTED (guard not weakened)
import { readFileSync } from "node:fs";

const lines = readFileSync(".env", "utf8").split(/\r?\n/);
const v = (n) =>
  (lines.find((l) => l.startsWith(n)) ?? "").replace(new RegExp("^" + n + '=\"?'), "").replace(/"$/, "");

const APP_URL = v("APP_URL");
const BASE = "http://localhost:3010";

const login = await fetch(BASE + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: v("ADMIN_EMAIL"), password: v("ADMIN_PASSWORD") }),
});
if (!login.ok) { console.log("login failed: " + login.status); process.exit(1); }
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
console.log("login -> HTTP " + login.status + "   (session established)");
console.log("");

const before = (await (await fetch(BASE + "/api/settings", { headers: { cookie } })).json()).settings;
const list = await (await fetch(BASE + "/api/campaigns", { headers: { cookie } })).json();
const c = (list.campaigns ?? list)[0];

const call = (path, method, body, origin) => {
  const headers = { "Content-Type": "application/json", cookie };
  if (origin) headers.Origin = origin;
  return fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
};

console.log("=== PATCH /api/settings  (saves the CURRENT values back unchanged) ===");
const rows = [
  ["http://localhost:3010", BASE, "your browser - should now WORK"],
  [APP_URL, APP_URL, "the tunnel URL - must still work"],
  // LAN was allowlisted on 2026-10-02 so the phone / other laptops on this Wi-Fi
  // can save. If the router reassigns a new DHCP address this row goes stale and
  // phone saves 403 again -- update ALLOWED_ORIGINS in .env.
  ["http://192.168.1.5:3010", "http://192.168.1.5:3010", "your LAN device - should now WORK"],
  // A DIFFERENT private address is NOT allowlisted and must stay blocked, so
  // allowlisting this PC's IP did not widen the rule to the whole subnet.
  ["http://192.168.1.99:3010", "http://192.168.1.99:3010", "other LAN address - must stay blocked"],
  ["https://evil.example", "https://evil.example", "hostile origin - must stay blocked"],
  ["null", "null", "sandboxed iframe - must stay blocked"],
];
for (const [label, origin, note] of rows) {
  const r = await call("/api/settings", "PATCH", before, origin);
  const ok = r.status === 200;
  const want = note.includes("should now WORK") || note.includes("must still work");
  const verdict = ok === want ? "PASS" : "FAIL";
  console.log("  " + verdict + "  Origin " + label.padEnd(46) + "-> HTTP " + r.status + "   (" + note + ")");
}

console.log("");
console.log("=== POST /api/campaigns/[id]/status  (no-op: pause an already-paused campaign) ===");
for (const [label, origin, wantOk] of [
  ["http://localhost:3010", BASE, true],
  [APP_URL, APP_URL, true],
  ["https://evil.example", "https://evil.example", false],
]) {
  const r = await call("/api/campaigns/" + c.id + "/status", "POST", { action: "pause" }, origin);
  // 400 = got PAST the origin+session checks and hit the state guard (good)
  // 403 = blocked at the origin check
  const passed = wantOk ? r.status === 400 : r.status === 403;
  console.log("  " + (passed ? "PASS" : "FAIL") + "  Origin " + label.padEnd(46) + "-> HTTP " + r.status);
}

const after = (await (await fetch(BASE + "/api/settings", { headers: { cookie } })).json()).settings;
const vals = (s) => { const { id, userId, updatedAt, ...r } = s; return r; };
console.log("");
console.log("dailySendLimit still : " + after.dailySendLimit);
console.log("all other values identical: " + (JSON.stringify(vals(before)) === JSON.stringify(vals(after))));
console.log("campaign still       : " + c.name + " / " + c.status);
