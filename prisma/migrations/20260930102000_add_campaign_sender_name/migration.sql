-- Add a per-campaign sender display name.
--
-- Nullable with no default, so this is purely additive: every existing campaign
-- (including any that is mid-send) keeps NULL and therefore keeps falling back
-- to the global SENDER_NAME env value. No rows are read, written or rewritten.
--
-- This column is a DISPLAY NAME only. The From address still comes from the
-- campaign's selected sending account, so it cannot be used to spoof a sender.

ALTER TABLE "Campaign" ADD COLUMN "senderName" TEXT;