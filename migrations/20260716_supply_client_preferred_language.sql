-- Persist WhatsApp client preferred language for Munafe Supply bot replies.
-- Values: en | hi | bn | mr | te | ta  (default en)

ALTER TABLE supply_clients
  ADD COLUMN IF NOT EXISTS preferred_language text NOT NULL DEFAULT 'en';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'supply_clients_preferred_language_check'
  ) THEN
    ALTER TABLE supply_clients
      ADD CONSTRAINT supply_clients_preferred_language_check
      CHECK (preferred_language = ANY (ARRAY['en', 'hi', 'bn', 'mr', 'te', 'ta']));
  END IF;
END $$;
