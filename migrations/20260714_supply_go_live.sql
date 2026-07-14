-- Go-live: reservation status + catalog unit_type
-- Apply in Supabase SQL editor (or via migration runner).

-- 1) Allow 'requested' on supply_orders.status
-- Drop existing CHECK if present (name may vary); recreate with requested.
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  WHERE t.relname = 'supply_orders'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status%';

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE supply_orders DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE supply_orders
  ADD CONSTRAINT supply_orders_status_check
  CHECK (status = ANY (ARRAY[
    'requested',
    'confirmed',
    'out_for_delivery',
    'delivered',
    'partially_delivered',
    'cancelled'
  ]));

-- Keep column default as confirmed for backward compatibility;
-- app insert path sets 'requested' for form submissions.

-- 2) Count vs weight/volume on catalog items
ALTER TABLE supply_catalog_items
  ADD COLUMN IF NOT EXISTS unit_type text NOT NULL DEFAULT 'weight';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'supply_catalog_items_unit_type_check'
  ) THEN
    ALTER TABLE supply_catalog_items
      ADD CONSTRAINT supply_catalog_items_unit_type_check
      CHECK (unit_type = ANY (ARRAY['count', 'weight', 'volume']));
  END IF;
END $$;

-- Backfill sensible unit_type from existing unit values
UPDATE supply_catalog_items
SET unit_type = CASE
  WHEN lower(unit) IN ('piece', 'dozen', 'pcs', 'pc', 'bunch') THEN 'count'
  WHEN lower(unit) IN ('litre', 'liter', 'ml', 'l') THEN 'volume'
  ELSE 'weight'
END
WHERE unit_type = 'weight';
