-- Add 'rejected' to booking_status_enum (used by manager reject-booking command).
-- Safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'booking_status_enum'
      AND e.enumlabel = 'rejected'
  ) THEN
    ALTER TYPE booking_status_enum ADD VALUE 'rejected';
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
