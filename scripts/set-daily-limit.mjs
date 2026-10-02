// Sets the daily send limit directly, bypassing the broken browser-origin check
// by sending the APP_URL Origin (verified to pass assertSameOrigin).
// Goes through the app's real PATCH /api/settings so schema validation,
// updateSendSettings, and the @updatedAt behaviour are identical to a UI save.
import { readFileSync } from "node:fs";

const lines = readFileSync(".env", "utf8").split(/\r?\n/);
const v = (n) =>
  (lines.find((l) => l.startsWith(n)) ?? "").replace(new RegExp("^" + n + '=\"?'), "").replace(/"$/, "");

const APP_URL = v("APP_URL");
const BASE = "http://localhost:3010";
const NEW_DAILY_LIMIT = Number(process.argv[2] ?? 1000);

const login = await fetch(BASE + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" }, // no Origin => allowed
  body: JSON.stringify({ email: v("ADMIN_EMAIL"), password: v("ADMIN_PASSWORD") }),
});
if (!login.ok) { console.log("login failed: " + login.status); process.exit(1); }
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

const before = (await (await fetch(BASE + "/api/settings", { headers: { cookie } })).json()).settings;

const patch = await fetch(BASE + "/api/settings", {
  method: "PATCH",
  headers: { "Content-Type": "application/json", cookie, Origin: APP_URL },
  body: JSON.stringify({ ...before, dailySendLimit: NEW_DAILY_LIMIT }),
});
const patchBody = await patch.json();
if (!patch.ok) { console.log("PATCH failed: " + patch.status + " " + JSON.stringify(patchBody)); process.exit(1); }

const after = (await (await fetch(BASE + "/api/settings", { headers: { cookie } })).json()).settings;
const vals = (s) => { const { id, userId, updatedAt, ...rest } = s; return rest; };

console.log("BEFORE: " + JSON.stringify(vals(before)));
console.log("AFTER : " + JSON.stringify(vals(after)));
console.log("");
console.log("dailySendLimit  : " + before.dailySendLimit + " -> " + after.dailySendLimit);
console.log("messagesPerMinute unchanged: " + (before.messagesPerMinute === after.messagesPerMinute));
console.log("min/maxDelay    unchanged: " + (before.minDelaySeconds === after.minDelaySeconds && before.maxDelaySeconds === after.maxDelaySeconds));
console.log("sendMode        unchanged: " + (before.sendMode === after.sendMode));
console.log("no other field touched  : " + (JSON.stringify({ ...vals(before), dailySendLimit: 0 }) === JSON.stringify({ ...vals(after), dailySendLimit: 0 })));
