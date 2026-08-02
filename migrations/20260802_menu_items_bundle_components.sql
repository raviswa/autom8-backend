-- Bundle/hamper component map on menu_items.
-- Used by food_products (and any catalog LOB) for stock expansion at checkout.
-- Code also stores the same data in meta.bundle_components as a fallback.
-- Safe to run multiple times.

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS bundle_components jsonb;

COMMENT ON COLUMN menu_items.bundle_components IS
  'For item_type BUNDLE/HAMPER: JSON array of {retailer_id, qty} component SKUs. Also mirrored in meta.bundle_components.';
