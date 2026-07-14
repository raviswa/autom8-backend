-- Add item_type for PSL catalog uploads (PIZZA vs PRODUCT).
-- Safe to run if add_menu_item_variant_fields_and_meta.sql was already applied
-- without item_type.

BEGIN;

ALTER TABLE public.menu_items
  ADD COLUMN IF NOT EXISTS item_type text NULL DEFAULT 'PRODUCT';

COMMIT;
