-- Per-mailbox sender/display name (From-header name) for SMTP mailboxes.
-- NULL means "default to the email's local part" when constructing the From
-- header; a stored value is used verbatim (sanitized on write). Additive only:
-- every existing row simply keeps its NULL default.
ALTER TABLE "SmtpAccount" ADD COLUMN "displayName" TEXT;