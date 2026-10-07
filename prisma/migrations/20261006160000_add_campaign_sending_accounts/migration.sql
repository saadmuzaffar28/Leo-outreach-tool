-- Multi-mailbox campaign selection: the deterministic set of SMTP mailboxes a
-- campaign may send from, in position order. Legacy campaigns have no rows here
-- and keep using Campaign.smtpAccountId exactly as before.
CREATE TABLE "CampaignSendingAccount" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "smtpAccountId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CampaignSendingAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CampaignSendingAccount_campaignId_smtpAccountId_key"
    ON "CampaignSendingAccount"("campaignId", "smtpAccountId");
CREATE INDEX "CampaignSendingAccount_campaignId_idx"
    ON "CampaignSendingAccount"("campaignId");
CREATE INDEX "CampaignSendingAccount_smtpAccountId_idx"
    ON "CampaignSendingAccount"("smtpAccountId");

ALTER TABLE "CampaignSendingAccount"
    ADD CONSTRAINT "CampaignSendingAccount_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignSendingAccount"
    ADD CONSTRAINT "CampaignSendingAccount_smtpAccountId_fkey"
    FOREIGN KEY ("smtpAccountId") REFERENCES "SmtpAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Frozen per-recipient sending mailbox, assigned exactly once when the campaign
-- starts so retries and worker restarts never re-rotate the mailbox (or its
-- signature). NULL for legacy and Gmail/Outlook campaigns.
ALTER TABLE "CampaignRecipient" ADD COLUMN "smtpAccountId" TEXT;

ALTER TABLE "CampaignRecipient"
    ADD CONSTRAINT "CampaignRecipient_smtpAccountId_fkey"
    FOREIGN KEY ("smtpAccountId") REFERENCES "SmtpAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "CampaignRecipient_smtpAccountId_idx"
    ON "CampaignRecipient"("smtpAccountId");