-- Order operations layout: combined (journey on Packing) vs split (Manager journey, Packing actions only).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS order_ops_mode TEXT NOT NULL DEFAULT 'combined';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_order_ops_mode_check'
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_order_ops_mode_check
      CHECK (order_ops_mode IN ('combined', 'split'));
  END IF;
END $$;

COMMENT ON COLUMN tenants.order_ops_mode IS
  'combined = Prep→Delivery journey on Packing screen (small team); split = Manager owns journey, Packing packs only.';
