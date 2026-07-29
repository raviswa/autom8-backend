-- Fix readymade Sweets / Savories that currently route to cooking KDS,
-- then requeue open tickets so Packing fills immediately.
--
-- Hotel Munafe demo tenant. Preview with the SELECTs before UPDATE.
-- Safe to re-run.

-- 1) Preview menu rows that will move to sweets_counter:
-- SELECT id, name, category, kitchen_station
-- FROM menu_items
-- WHERE restaurant_id = '46fb9b9e-431a-43c9-9edb-d316b0fef216'
--   AND COALESCE(kitchen_station, '') NOT IN ('sweets_counter', 'packing', 'dispatch')
--   AND (
--     category ~* '(sweet|savor|savour|readymade|ready.?made|mithai|namkeen|bakery|pre.?pack|confection)'
--     OR COALESCE(kitchen_station, '') IN ('', 'assembly')
--        AND category ~* '(sweet|savor|savour|readymade|ready.?made|mithai|namkeen)'
--   );

UPDATE menu_items
SET kitchen_station = 'sweets_counter'
WHERE restaurant_id = '46fb9b9e-431a-43c9-9edb-d316b0fef216'
  AND COALESCE(kitchen_station, '') NOT IN ('sweets_counter', 'packing', 'dispatch')
  AND (
    category ~* '(sweet|savor|savour|readymade|ready.?made|mithai|namkeen|bakery|pre.?pack|confection)'
    OR (
      COALESCE(kitchen_station, 'assembly') = 'assembly'
      AND category ~* '(sweet|savor|savour|readymade|ready.?made|mithai|namkeen)'
    )
  );

-- 2) Preview open cooking tickets that should be packing:
-- SELECT ki.id, ki.item_name, ki.kitchen_station, ki.queue, ki.status, ki.token_number
-- FROM kds_items ki
-- JOIN order_items oi ON oi.id = ki.order_item_id
-- JOIN menu_items mi ON mi.id = oi.menu_item_id
-- WHERE mi.restaurant_id = '46fb9b9e-431a-43c9-9edb-d316b0fef216'
--   AND ki.queue = 'cooking'
--   AND ki.status IN ('pending', 'in_progress')
--   AND (
--     mi.kitchen_station IN ('sweets_counter', 'packing', 'dispatch')
--     OR mi.category ~* '(sweet|savor|savour|readymade|ready.?made|mithai|namkeen|bakery|pre.?pack|confection)'
--   );

-- Move open sweets/savories tickets from Kitchen → Packing (does not touch ready/completed).
UPDATE kds_items ki
SET
  kitchen_station = 'sweets_counter',
  queue = 'packing'
FROM order_items oi
JOIN menu_items mi ON mi.id = oi.menu_item_id
WHERE ki.order_item_id = oi.id
  AND mi.restaurant_id = '46fb9b9e-431a-43c9-9edb-d316b0fef216'
  AND ki.queue = 'cooking'
  AND ki.status IN ('pending', 'in_progress')
  AND (
    mi.kitchen_station IN ('sweets_counter', 'packing', 'dispatch')
    OR mi.category ~* '(sweet|savor|savour|readymade|ready.?made|mithai|namkeen|bakery|pre.?pack|confection)'
  );
