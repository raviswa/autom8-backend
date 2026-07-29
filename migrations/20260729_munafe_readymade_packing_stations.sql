-- Fix readymade Sweets / Savories / similar categories that currently route to
-- the cooking KDS (blank or hot kitchen_station) → packing via sweets_counter.
--
-- Hotel Munafe demo tenant. Re-run SELECT preview before UPDATE on other outlets.
-- Safe to re-run (idempotent for already-correct rows).

-- Preview (optional):
-- SELECT id, name, category, kitchen_station
-- FROM menu_items
-- WHERE restaurant_id = '46fb9b9e-431a-43c9-9edb-d316b0fef216'
--   AND COALESCE(kitchen_station, '') NOT IN ('sweets_counter', 'packing', 'dispatch')
--   AND category ~* '(sweet|savor|savour|readymade|ready.?made|mithai|namkeen|bakery|pre.?pack|confection)';

UPDATE menu_items
SET kitchen_station = 'sweets_counter'
WHERE restaurant_id = '46fb9b9e-431a-43c9-9edb-d316b0fef216'
  AND COALESCE(kitchen_station, '') NOT IN ('sweets_counter', 'packing', 'dispatch')
  AND category ~* '(sweet|savor|savour|readymade|ready.?made|mithai|namkeen|bakery|pre.?pack|confection)';
