-- Persist prepay fulfillment payload on booking row (survives session reset / webhook race).
-- Run once in Supabase SQL editor.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS prepay_fulfillment_payload jsonb;

COMMENT ON COLUMN bookings.prepay_fulfillment_payload IS
  'Stashed KDS/receipt payload while awaiting Razorpay prepay. Cleared after successful fulfillment.';

CREATE INDEX IF NOT EXISTS idx_bookings_pending_prepay
  ON bookings (restaurant_id, created_at)
  WHERE payment_status = 'pending' AND status = 'pending' AND prepay_fulfillment_payload IS NOT NULL;
