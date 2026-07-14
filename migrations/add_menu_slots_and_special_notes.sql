-- Addendum C: menu source-of-truth extensions
-- - Category-level applicable slots with item-level override
-- - Today's special note + recurring flag
-- - Optional primary slot category mapping on tenants

BEGIN;

CREATE TABLE IF NOT EXISTS public.menu_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  applicable_slots text[] NOT NULL DEFAULT ARRAY['anytime']::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, name)
);

ALTER TABLE public.menu_items
  ADD COLUMN IF NOT EXISTS applicable_slots text[] NULL,
  ADD COLUMN IF NOT EXISTS special_note text NULL,
  ADD COLUMN IF NOT EXISTS recurring_special boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_todays_special boolean NOT NULL DEFAULT false;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS primary_slot_category jsonb NULL;

CREATE INDEX IF NOT EXISTS idx_menu_categories_restaurant
  ON public.menu_categories (restaurant_id);

CREATE INDEX IF NOT EXISTS idx_menu_items_slots_gin
  ON public.menu_items USING gin (applicable_slots);

CREATE INDEX IF NOT EXISTS idx_menu_items_todays_special
  ON public.menu_items (restaurant_id)
  WHERE is_todays_special = true OR is_special_today = true;

-- Keep legacy and new special flags in sync.
UPDATE public.menu_items
SET is_todays_special = is_special_today
WHERE is_todays_special IS DISTINCT FROM is_special_today;

-- Seed category defaults from existing menu_items categories.
INSERT INTO public.menu_categories (restaurant_id, name, applicable_slots)
SELECT mi.restaurant_id,
       mi.category,
       CASE
         WHEN lower(mi.category) IN ('tiffin', 'breakfast', 'morning tiffin') THEN ARRAY['tiffin']::text[]
         WHEN lower(mi.category) IN ('rice & meals', 'rice and meals', 'meals') THEN ARRAY['lunch','dinner']::text[]
         WHEN lower(mi.category) IN ('snacks', 'beverages', 'sweets') THEN ARRAY['anytime']::text[]
         ELSE ARRAY['anytime']::text[]
       END AS applicable_slots
FROM public.menu_items mi
WHERE mi.category IS NOT NULL
  AND mi.category <> ''
ON CONFLICT (restaurant_id, name) DO NOTHING;

COMMIT;
