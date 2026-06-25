-- Takeaway QR collection columns on orders (captain portal scan).
-- Run once in Supabase SQL editor if scan fails with missing column errors.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS takeaway_status   text,
  ADD COLUMN IF NOT EXISTS collected_at      timestamptz,
  ADD COLUMN IF NOT EXISTS collected_by      text,
  ADD COLUMN IF NOT EXISTS collected_counter text;

COMMENT ON COLUMN public.orders.takeaway_status IS
  'pending | collected — set when captain scans receipt QR at counter';

CREATE INDEX IF NOT EXISTS idx_orders_takeaway_collected
  ON public.orders (restaurant_id, collected_at)
  WHERE collected_at IS NOT NULL;
