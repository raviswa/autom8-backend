-- Multi-LOB supply catalogs: suppliers declare what kind of goods they sell.
-- Buyers (supply_clients) stay LOB-agnostic.

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS lob_type text NOT NULL DEFAULT 'food_service';

UPDATE public.suppliers
SET lob_type = 'food_service'
WHERE lob_type IS NULL OR btrim(lob_type) = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'suppliers_lob_type_check'
      AND conrelid = 'public.suppliers'::regclass
  ) THEN
    ALTER TABLE public.suppliers
      ADD CONSTRAINT suppliers_lob_type_check
      CHECK (lob_type = ANY (ARRAY[
        'food_service'::text,
        'food_products'::text,
        'retail'::text,
        'packaging'::text,
        'general'::text
      ]));
  END IF;
END $$;

COMMENT ON COLUMN public.suppliers.lob_type IS
  'Catalog schema for this supplier (categories/units/GST). Buyers are any LOB.';
