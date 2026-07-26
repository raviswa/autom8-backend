-- Safe to run multiple times.
-- Stores structured catalog metadata such as bundle component definitions.

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::JSONB;

COMMENT ON COLUMN menu_items.meta IS
  'Structured catalog metadata. Used for bundle components and future LOB-specific attributes.';
