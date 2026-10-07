-- AlterTable
ALTER TABLE "VerificationJob" ADD COLUMN     "batchId" TEXT;

-- CreateTable
CREATE TABLE "VerificationBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "queued" INTEGER NOT NULL DEFAULT 0,
    "running" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "valid" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "risky" INTEGER NOT NULL DEFAULT 0,
    "catchAll" INTEGER NOT NULL DEFAULT 0,
    "unknown" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "VerificationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VerificationBatch_userId_createdAt_idx" ON "VerificationBatch"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "VerificationBatch_userId_status_idx" ON "VerificationBatch"("userId", "status");

-- CreateIndex
CREATE INDEX "VerificationJob_batchId_idx" ON "VerificationJob"("batchId");

-- AddForeignKey
ALTER TABLE "VerificationJob" ADD CONSTRAINT "VerificationJob_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "VerificationBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
