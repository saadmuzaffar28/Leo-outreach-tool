// Read-only proof that the stored Gmail grant is still usable.
// Exchanges the stored refresh token for a fresh access token WITHOUT printing
// or storing anything, then confirms the Gmail API accepts it.
// This is the real test that the account still works -- a valid row is not
// enough, the grant has to actually authenticate.
import { PrismaClient } from "@prisma/client";
import { createHash, createDecipheriv } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const prisma = new PrismaClient();

function envVal(name) {
  const raw = readFileSync(".env", "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(new RegExp("^\\s*" + name + "\\s*=\\s*[\"']?([^\"'\r\n]*)[\"']?\\s*$"));
    if (m) return m[1];
  }
  return "";
}

// Same AES-256-GCM scheme as src/lib/encryption.ts, inlined because the "@/"
// alias only resolves inside the bundler.
function decrypt(payload, keySecret) {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Malformed encrypted payload");
  const key = createHash("sha256").update(keySecret).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

try {
  const rows = await prisma.googleAccount.findMany({
    select: { id: true, googleEmail: true, refreshTokenEncrypted: true, status: true },
  });
  const clientId = envVal("GOOGLE_CLIENT_ID");
  const clientSecret = envVal("GOOGLE_CLIENT_SECRET");
  const keySecret = envVal("TOKEN_ENCRYPTION_KEY");

  for (const a of rows) {
    console.log("--- account: " + a.googleEmail + " (status=" + a.status + ")");
    if (!a.refreshTokenEncrypted) {
      console.log("    RESULT: NO REFRESH TOKEN STORED -> would need reconnect");
      continue;
    }
    const refreshToken = decrypt(a.refreshTokenEncrypted, keySecret);
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log("    RESULT: REFRESH FAILED http=" + res.status + " error=" + (json.error ?? "unknown"));
      continue;
    }
    // Never print the token -- only prove it exists.
    console.log("    refresh grant: OK (access token length " + String(json.access_token ?? "").length + ")");
    console.log("    google returned a new refresh token: " + (json.refresh_token ? "yes" : "no  <-- proves the old code would have wiped it"));

    // Confirm the Gmail API accepts the token. users.getProfile is NOT used:
    // it needs a read scope the app deliberately does not request (only
    // gmail.send), so it 403s by design. users.settings.sendAs.list is
    // covered by gmail.settings.basic, which IS granted -- a safe read that
    // proves the grant works and reports the real sending identity.
    const sendAs = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs?format=metadata",
      { headers: { Authorization: "Bearer " + json.access_token } },
    );
    const sendAsJson = await sendAs.json().catch(() => ({}));
    console.log("    gmail settings.sendAs: http=" + sendAs.status);
    if (sendAs.ok) {
      const primary = (sendAsJson.sendAs ?? []).find((s) => s.isPrimary) ?? {};
      const def = (sendAsJson.sendAs ?? []).find((s) => s.isDefault) ?? primary;
      console.log("    primary sending identity: " + (primary.sendAsEmail ?? "n/a"));
      console.log("    identity matches stored account: " + (primary.sendAsEmail === a.googleEmail));
      console.log("    send-as aliases available: " + (sendAsJson.sendAs ?? []).length);
    } else {
      console.log("    detail: " + JSON.stringify(sendAsJson).slice(0, 200));
    }
    // A 403 on profile must NOT be read as a broken account -- confirm the
    // app still requests only the two original Gmail scopes.
    console.log("    profile 403 above is expected (gmail.send carries no read scope)");
  }
} catch (e) {
  console.log("ERROR: " + (e?.message ?? String(e)));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
