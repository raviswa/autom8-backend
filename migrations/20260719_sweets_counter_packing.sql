-- Sweets / packing counter: separate KDS queue from live cooking board.
-- Billing unchanged — split is kds_items.queue only.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS sweets_counter_phone varchar(20);

ALTER TABLE public.kds_items
  ADD COLUMN IF NOT EXISTS kitchen_station text,
  ADD COLUMN IF NOT EXISTS queue text NOT NULL DEFAULT 'cooking';

UPDATE public.kds_items
SET queue = 'packing'
WHERE kitchen_station = 'sweets_counter'
  AND queue IS DISTINCT FROM 'packing';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kds_items_queue_check'
  ) THEN
    ALTER TABLE public.kds_items
      ADD CONSTRAINT kds_items_queue_check
      CHECK (queue = ANY (ARRAY['cooking'::text, 'packing'::text]));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kds_items_restaurant_queue_status
  ON public.kds_items (restaurant_id, queue, status);

-- Expand menu kitchen_station allow-list to include sweets_counter
ALTER TABLE public.menu_items
  DROP CONSTRAINT IF EXISTS menu_items_kitchen_station_check;

ALTER TABLE public.menu_items
  ADD CONSTRAINT menu_items_kitchen_station_check
  CHECK (kitchen_station = ANY (ARRAY[
    'tawa'::text,
    'steamer'::text,
    'kadai'::text,
    'beverages'::text,
    'assembly'::text,
    'cold'::text,
    'sweets_counter'::text
  ]));
