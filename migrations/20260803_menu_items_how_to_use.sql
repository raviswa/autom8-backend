-- Enzyme Planet Phase 1: how_to_use for retail / ingredient-led catalogs.
-- Safe to run multiple times.

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS how_to_use text;

COMMENT ON COLUMN menu_items.how_to_use IS
  'Usage / how-to-apply copy for retail and packaged SKUs (shown in storefront / catalog)';
