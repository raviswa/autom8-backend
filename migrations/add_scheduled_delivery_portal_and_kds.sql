-- Scheduled delivery portal token type + deferred KDS lead time.
-- Run once in Supabase SQL editor.
-- Also run: add_prepay_fulfillment_payload.sql (Razorpay prepay fulfillment persistence).
-- Allow walk_in_tokens.type = 'scheduled_delivery' (enum or text check).
DO $$
DECLARE
  col_type regtype;
BEGIN
  SELECT a.atttypid::regtype INTO col_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = 'walk_in_tokens'
    AND a.attname = 'type'
    AND NOT a.attisdropped
    AND n.nspname = 'public';

  IF col_type IS NULL THEN
    RAISE NOTICE 'walk_in_tokens.type column not found — skip enum migration';
  ELSIF col_type::text LIKE '%enum%' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      WHERE t.oid = col_type::oid
        AND e.enumlabel = 'scheduled_delivery'
    ) THEN
      EXECUTE format('ALTER TYPE %s ADD VALUE ''scheduled_delivery''', col_type);
    END IF;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN OTHERS THEN
    RAISE NOTICE 'scheduled_delivery enum add skipped: %', SQLERRM;
END $$;

-- CHECK constraint (text/varchar type column) — enum migration above does not cover this.
ALTER TABLE walk_in_tokens
  DROP CONSTRAINT IF EXISTS walk_in_tokens_type_check;

ALTER TABLE walk_in_tokens
  ADD CONSTRAINT walk_in_tokens_type_check
  CHECK (type::text IN ('dinein', 'takeaway', 'large_party', 'scheduled_delivery'));

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS scheduled_kds_lead_minutes integer NOT NULL DEFAULT 150;

COMMENT ON COLUMN restaurants.scheduled_kds_lead_minutes IS
  'Minutes before scheduled_at to release order to KDS (typical 120–180). Prevents early prep for future slots.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurants_scheduled_kds_lead_minutes_check'
  ) THEN
    ALTER TABLE restaurants
      ADD CONSTRAINT restaurants_scheduled_kds_lead_minutes_check
      CHECK (scheduled_kds_lead_minutes BETWEEN 30 AND 480);
  END IF;
END $$;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS kds_sent_at timestamptz;

COMMENT ON COLUMN bookings.kds_sent_at IS
  'When the order was pushed to KDS. NULL = deferred until scheduled_kds_lead_minutes before booking_datetime.';

CREATE INDEX IF NOT EXISTS idx_bookings_deferred_kds
  ON bookings (restaurant_id, booking_datetime)
  WHERE kds_sent_at IS NULL AND booking_datetime IS NOT NULL;
