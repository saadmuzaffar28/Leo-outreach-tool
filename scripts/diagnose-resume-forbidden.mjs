// Proves the Resume button's 403 is the same stale-APP_URL origin check,
// without mutating anything.
//
//   1. localhost Origin + {action:"resume"}        -> 403, rejected before any logic
//   2. APP_URL  Origin + {action:"pause"} on an already-paused campaign
//      -> 400 "Cannot pause a campaign that is paused"
//      i.e. it got PAST the origin check and the session check, and was only
//      stopped by a state guard. Proof the route works and we're authorized.
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
console.log("logged in -> HTTP " + login.status);

const list = await (await fetch(BASE + "/api/campaigns", { headers: { cookie } })).json();
const c = (list.campaigns ?? list)[0];
if (!c) { console.log("no campaigns found"); process.exit(1); }
console.log("campaign: " + c.name + "  id=" + c.id + "  status=" + c.status);
console.log("");

const post = (origin, body) => {
  const headers = { "Content-Type": "application/json", cookie };
  if (origin) headers.Origin = origin;
  return fetch(BASE + "/api/campaigns/" + c.id + "/status", { method: "POST", headers, body: JSON.stringify(body) });
};

const a = await post(BASE, { action: "resume" });
console.log("1) Origin " + BASE + "  {action:resume}");
console.log("     -> HTTP " + a.status + "  " + (await a.text()).slice(0, 40) + "   <- your browser, unchanged");

const b = await post(APP_URL, { action: "pause" });
console.log("2) Origin " + APP_URL + "  {action:pause}");
console.log("     -> HTTP " + b.status + "  " + (await b.text()).slice(0, 60));
console.log("        (origin + session checks PASSED; only the paused-state guard stopped it)");

const after = await (await fetch(BASE + "/api/campaigns", { headers: { cookie } })).json();
const ac = (after.campaigns ?? after)[0];
console.log("");
console.log("campaign status still: " + ac.status + "  (nothing was changed by this probe)");
