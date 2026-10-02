-- AlterTable
ALTER TABLE "EmailTemplate" ADD COLUMN     "signatureOverride" TEXT,
ADD COLUMN     "useSignature" BOOLEAN NOT NULL DEFAULT true;
