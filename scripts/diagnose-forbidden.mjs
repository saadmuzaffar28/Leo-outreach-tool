// Isolates the same-origin check as the ONLY blocker. Logs in over localhost
// WITHOUT an Origin header (which assertSameOrigin explicitly allows for
// non-browser clients), then PATCHes the current settings back unchanged
// using each possible Origin. Nothing is modified.
import { readFileSync } from "node:fs";

const APP_URL = (readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith("APP_URL")) ?? "")
  .replace(/^APP_URL="?/, "").replace(/"$/, "");
const lines = readFileSync(".env", "utf8").split(/\r?\n/);
const v = (n) => (lines.find((l) => l.startsWith(n)) ?? "").replace(new RegExp("^" + n + '="?'), "").replace(/"$/, "");

const BASE = "http://localhost:3010";
let cookie = "";

const login = await fetch(BASE + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },   // deliberately NO Origin
  body: JSON.stringify({ email: v("ADMIN_EMAIL"), password: v("ADMIN_PASSWORD") }),
});
cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
console.log("login with NO Origin header      -> HTTP " + login.status);
console.log("  (assertSameOrigin returns true when Origin is absent, so this proves");
console.log("   the account + password are fine and the DB is reachable)");

const current = await (await fetch(BASE + "/api/settings", { headers: { cookie } })).json();
console.log("");
console.log("current limits: " + JSON.stringify(current.settings));

const cases = [
  ["(no Origin header)", null],
  ["http://localhost:3010", "http://localhost:3010"],
  ["http://192.168.1.5:3010", "http://192.168.1.5:3010"],
  [APP_URL, APP_URL],
];
console.log("");
console.log("=== PATCH /api/settings (identical payload each time) ===");
for (const [label, origin] of cases) {
  const headers = { "Content-Type": "application/json", cookie };
  if (origin) headers.Origin = origin;
  const r = await fetch(BASE + "/api/settings", { method: "PATCH", headers, body: JSON.stringify(current.settings) });
  const body = (await r.text()).slice(0, 45);
  console.log("  Origin " + label.padEnd(38) + "-> HTTP " + r.status + "  " + body);
}

const after = await (await fetch(BASE + "/api/settings", { headers: { cookie } })).json();
console.log("");
console.log("settings unchanged throughout: " + (JSON.stringify(after.settings) === JSON.stringify(current.settings)));
console.log("APP_URL the server compares against: " + APP_URL);
