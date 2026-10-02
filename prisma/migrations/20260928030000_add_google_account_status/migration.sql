-- AlterTable
ALTER TABLE "GoogleAccount" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'connected',
ADD COLUMN     "statusMessage" TEXT;

-- CreateIndex
CREATE INDEX "GoogleAccount_status_idx" ON "GoogleAccount"("status");
