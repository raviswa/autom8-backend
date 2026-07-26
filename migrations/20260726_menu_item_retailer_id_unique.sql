-- Safe to run multiple times.
-- A retailer_id is the stable external SKU and must be unique among active
-- catalog items for one tenant. Preserve older duplicates for order history.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY restaurant_id, UPPER(TRIM(retailer_id))
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS duplicate_rank
  FROM menu_items
  WHERE retailer_id IS NOT NULL
    AND TRIM(retailer_id) <> ''
    AND archived_at IS NULL
)
UPDATE menu_items AS item
SET
  archived_at = NOW(),
  is_stocked = FALSE,
  is_available = FALSE,
  updated_at = NOW()
FROM ranked
WHERE item.id = ranked.id
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_menu_items_active_retailer_id
  ON menu_items (restaurant_id, UPPER(TRIM(retailer_id)))
  WHERE retailer_id IS NOT NULL
    AND TRIM(retailer_id) <> ''
    AND archived_at IS NULL;

COMMENT ON INDEX uq_menu_items_active_retailer_id IS
  'One active catalog row per case-insensitive retailer SKU within a tenant.';
