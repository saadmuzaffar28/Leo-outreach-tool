-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "pausedReason" TEXT;

-- AlterTable
ALTER TABLE "CampaignRecipient" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "GoogleAccount" ADD COLUMN     "consecutiveQuotaHits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastQuotaAt" TIMESTAMP(3),
ADD COLUMN     "quotaMessage" TEXT,
ADD COLUMN     "quotaPausedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SendSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dailySendLimit" INTEGER NOT NULL DEFAULT 100,
    "messagesPerMinute" INTEGER NOT NULL DEFAULT 3,
    "minDelaySeconds" INTEGER NOT NULL DEFAULT 20,
    "maxDelaySeconds" INTEGER NOT NULL DEFAULT 60,
    "maxRetryAttempts" INTEGER NOT NULL DEFAULT 5,
    "baseRetryDelaySeconds" INTEGER NOT NULL DEFAULT 60,
    "maxRetryDelaySeconds" INTEGER NOT NULL DEFAULT 3600,
    "sendMode" TEXT NOT NULL DEFAULT 'live',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SendSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailySendCounter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "googleAccountId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "messagesSent" INTEGER NOT NULL DEFAULT 0,
    "messagesFailed" INTEGER NOT NULL DEFAULT 0,
    "messagesSkipped" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DailySendCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SendSettings_userId_key" ON "SendSettings"("userId");

-- CreateIndex
CREATE INDEX "DailySendCounter_userId_date_idx" ON "DailySendCounter"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailySendCounter_googleAccountId_date_key" ON "DailySendCounter"("googleAccountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_recipient_key" ON "CampaignRecipient"("campaignId", "recipient");

-- AddForeignKey
ALTER TABLE "SendSettings" ADD CONSTRAINT "SendSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySendCounter" ADD CONSTRAINT "DailySendCounter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySendCounter" ADD CONSTRAINT "DailySendCounter_googleAccountId_fkey" FOREIGN KEY ("googleAccountId") REFERENCES "GoogleAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;