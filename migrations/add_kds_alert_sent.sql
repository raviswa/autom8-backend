-- KDS reconcile dedup: stop repeat manager alerts for the same paid-without-KDS booking.
-- Run once in Supabase SQL editor (and on Railway Postgres if mirrored).

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS kds_alert_sent boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN bookings.kds_alert_sent IS
  'Set true after reconcile_paid_orders_without_kds retries KDS or alerts the manager once.';

-- Silence historical backlog before the scheduler job picks them up again.
UPDATE bookings
SET kds_alert_sent = true
WHERE created_at < NOW() - INTERVAL '3 hours'
  AND kds_alert_sent IS NOT TRUE;

CREATE INDEX IF NOT EXISTS idx_bookings_kds_reconcile
  ON bookings (payment_status, kds_sent_at, kds_alert_sent, created_at)
  WHERE payment_status = 'paid' AND kds_sent_at IS NULL AND kds_alert_sent IS NOT TRUE;
