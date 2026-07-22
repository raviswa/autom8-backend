-- Persistent loyalty points ledger (balance = SUM(delta) per restaurant+phone).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS loyalty_points_per_100_inr NUMERIC DEFAULT 1,
  ADD COLUMN IF NOT EXISTS loyalty_redeem_points INTEGER DEFAULT 100,
  ADD COLUMN IF NOT EXISTS loyalty_redeem_inr NUMERIC DEFAULT 50;

CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_phone TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_ledger_balance
  ON loyalty_ledger (restaurant_id, customer_phone);

-- Prevent double-earn for the same booking+reason.
CREATE UNIQUE INDEX IF NOT EXISTS uix_loyalty_earn_booking_reason
  ON loyalty_ledger (booking_id, reason)
  WHERE booking_id IS NOT NULL AND delta > 0;

COMMENT ON TABLE loyalty_ledger IS
  'Append-only loyalty points; balance is SUM(delta) per (restaurant_id, customer_phone).';
