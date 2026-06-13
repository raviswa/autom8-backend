-- Takeaway counter / QR fulfillment settings (Settings → Kitchen tab).
-- Fixes: [dashboard/waba] column restaurants.takeaway_fulfillment_mode does not exist
-- Run once in Supabase SQL editor.

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS takeaway_fulfillment_mode text NOT NULL DEFAULT 'single_counter',
  ADD COLUMN IF NOT EXISTS fulfillment_sections    jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN restaurants.takeaway_fulfillment_mode IS
  'single_counter = one packing window; multi_counter = sweets/kitchen/beverages collected separately';

COMMENT ON COLUMN restaurants.fulfillment_sections IS
  'JSON array of { "id": "sweets", "name": "Sweets & Savouries" } — used when mode is multi_counter';

-- Optional: constrain to known values (skip if you prefer loose text)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurants_takeaway_fulfillment_mode_check'
  ) THEN
    ALTER TABLE restaurants
      ADD CONSTRAINT restaurants_takeaway_fulfillment_mode_check
      CHECK (takeaway_fulfillment_mode IN ('single_counter', 'multi_counter'));
  END IF;
END $$;

-- Munafe demo: dine-in + simple takeaway — one counter is the usual default
UPDATE restaurants
SET
  takeaway_fulfillment_mode = COALESCE(takeaway_fulfillment_mode, 'single_counter'),
  fulfillment_sections      = COALESCE(fulfillment_sections, '[]'::jsonb)
WHERE id = '46fb9b9e-431a-43c9-9edb-d316b0fef216';

-- ── multi_counter only (optional) ───────────────────────────────────────────
-- If you later switch to "Multiple sections" in Manager Portal → Settings → Kitchen:
--
-- UPDATE restaurants
-- SET
--   takeaway_fulfillment_mode = 'multi_counter',
--   fulfillment_sections = '[
--     {"id":"sweets","name":"Sweets & Savouries"},
--     {"id":"kitchen","name":"Kitchen"},
--     {"id":"beverages","name":"Beverages"}
--   ]'::jsonb
-- WHERE id = '46fb9b9e-431a-43c9-9edb-d316b0fef216';
--
-- menu_items.fulfillment_section must match section ids (set via Settings UI
-- or bulk-section API). Requires RPCs create_fulfillment_groups / scan_takeaway_qr
-- if you use takeaway QR scanning at counters.
