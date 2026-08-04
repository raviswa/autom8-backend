-- Customer-facing storage guidance for packaged / retail catalogs.
-- Safe to run multiple times.

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS how_to_store text;

COMMENT ON COLUMN menu_items.how_to_store IS
  'Storage guidance for packaged and retail SKUs (e.g. cool dry place). Shown in storefront product detail.';
