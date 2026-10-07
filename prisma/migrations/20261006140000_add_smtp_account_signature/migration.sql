-- AlterTable
ALTER TABLE "SmtpAccount" ADD COLUMN     "signatureEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SmtpAccount" ADD COLUMN     "signatureHtml" TEXT;