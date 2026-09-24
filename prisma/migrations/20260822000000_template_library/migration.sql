-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "templateSnapshot" JSONB;

-- AlterTable
ALTER TABLE "EmailTemplate" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;