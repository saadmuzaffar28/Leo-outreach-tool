// Read-only safety snapshot of GoogleAccount + related counts.
// Tokens are NEVER printed -- only presence + a short fingerprint.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const out = {};
try {
  out.capturedAt = new Date().toISOString();
  const n = async (model) => {
    const d = prisma[model];
    if (!d?.count) return "n/a";
    try { return await d.count(); } catch (e) { return "err: " + e.message.split("\n")[0]; }
  };
  out.counts = {
    users: await n("user"),
    googleAccounts: await n("googleAccount"),
    microsoftAccounts: await n("microsoftAccount"),
    smtpAccounts: await n("smtpAccount"),
    campaigns: await n("campaign"),
    recipients: await n("campaignRecipient"),
    templates: await n("template"),
    leads: await n("lead"),
    groups: await n("group"),
  };

  const rows = await prisma.googleAccount.findMany();
  out.googleAccounts = rows.map((a) => ({
    id: a.id,
    userId: a.userId,
    googleEmail: a.googleEmail,
    scopes: a.scopes,
    // Fingerprints only -- proves the blobs are untouched without leaking them.
    accessTokenLen: a.accessTokenEncrypted?.length ?? 0,
    accessTokenSha: (a.accessTokenEncrypted ?? "").slice(0, 12),
    hasRefreshToken: !!a.refreshTokenEncrypted,
    refreshTokenLen: a.refreshTokenEncrypted?.length ?? 0,
    refreshTokenSha: (a.refreshTokenEncrypted ?? "").slice(0, 12),
    expiresAt: a.expiresAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    // Present only after the status migration has been generated.
    status: "status" in a ? a.status : "(column not yet added)",
    statusMessage: "statusMessage" in a ? a.statusMessage : "(column not yet added)",
    hasSignature: !!a.signature,
    signatureOverride: a.signatureOverride,
  }));
  out.campaignSenderBindings = await prisma.campaign.findMany({
    select: { id: true, name: true, status: true, googleAccountId: true, microsoftAccountId: true, smtpAccountId: true },
  });
  process.stdout.write(JSON.stringify(out, null, 2));
} catch (e) {
  process.stdout.write("SNAPSHOT_ERROR: " + (e?.message ?? String(e)));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
