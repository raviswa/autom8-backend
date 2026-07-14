-- Add flat variant columns + flexible metadata for schema-driven catalog uploads.
-- Backward-compatible: all new columns are nullable or defaulted.

BEGIN;

ALTER TABLE public.menu_items
  ADD COLUMN IF NOT EXISTS item_type text NULL DEFAULT 'PRODUCT',
  ADD COLUMN IF NOT EXISTS variant_group_id text NULL,
  ADD COLUMN IF NOT EXISTS size_label text NULL,
  ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Optimized lookup for grouped size variants in webcart rendering.
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant_variant_group
  ON public.menu_items (restaurant_id, variant_group_id)
  WHERE variant_group_id IS NOT NULL;

COMMIT;
