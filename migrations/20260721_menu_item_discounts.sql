-- Time-limited percent discounts on menu items (owner-set, shown in webcart).
-- Safe to run multiple times.

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS discount_percent numeric;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS discount_ends_at timestamptz;

COMMENT ON COLUMN menu_items.discount_percent IS
  'Percent off list price (1–100). NULL or <=0 means no discount.';
COMMENT ON COLUMN menu_items.discount_ends_at IS
  'Discount expires at this timestamp (UTC). NULL means inactive.';

-- Soft check: percent must be null or between 0 and 100 (0 treated as cleared).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'menu_items_discount_percent_range'
  ) THEN
    ALTER TABLE menu_items
      ADD CONSTRAINT menu_items_discount_percent_range
      CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100));
  END IF;
END $$;
