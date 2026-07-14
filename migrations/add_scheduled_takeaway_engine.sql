-- Scheduled takeaway scheduling engine (kitchen_start, slot capacity, persisted jobs).
-- Run once in Supabase SQL editor after fix_walk_in_tokens_scheduled_delivery_check.sql

-- ── Menu timing columns (Section 2) ──────────────────────────────────────────
ALTER TABLE public.menu_items
  ADD COLUMN IF NOT EXISTS prep_time_fixed integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS batch_size integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS time_per_batch integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS kitchen_station text NOT NULL DEFAULT 'assembly',
  ADD COLUMN IF NOT EXISTS packing_time numeric NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS holds_well boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_batch_size_check'
  ) THEN
    ALTER TABLE public.menu_items
      ADD CONSTRAINT menu_items_batch_size_check CHECK (batch_size >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_time_per_batch_check'
  ) THEN
    ALTER TABLE public.menu_items
      ADD CONSTRAINT menu_items_time_per_batch_check CHECK (time_per_batch >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_kitchen_station_check'
  ) THEN
    ALTER TABLE public.menu_items
      ADD CONSTRAINT menu_items_kitchen_station_check
      CHECK (kitchen_station = ANY (ARRAY[
        'tawa'::text, 'steamer'::text, 'kadai'::text,
        'beverages'::text, 'assembly'::text, 'cold'::text
      ]));
  END IF;
END $$;

-- ── Restaurant scheduling config ─────────────────────────────────────────────
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS scheduled_slot_max_orders integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS schedule_buffer_minutes integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS schedule_rounding_minutes integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS schedule_early_start_max_minutes integer NOT NULL DEFAULT 30;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurants_scheduled_slot_max_orders_check'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT restaurants_scheduled_slot_max_orders_check
      CHECK (scheduled_slot_max_orders BETWEEN 1 AND 100);
  END IF;
END $$;

-- ── Booking schedule fields ──────────────────────────────────────────────────
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS kitchen_start_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_slot_at timestamptz,
  ADD COLUMN IF NOT EXISTS total_cook_minutes integer,
  ADD COLUMN IF NOT EXISTS total_packing_minutes numeric,
  ADD COLUMN IF NOT EXISTS schedule_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_bookings_kitchen_start
  ON public.bookings (restaurant_id, kitchen_start_at)
  WHERE kitchen_start_at IS NOT NULL AND kds_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_scheduled_slot
  ON public.bookings (restaurant_id, scheduled_slot_at)
  WHERE scheduled_slot_at IS NOT NULL;

-- ── Persisted scheduler jobs (Section 8.1) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scheduled_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  booking_id uuid,
  token_id text,
  job_type text NOT NULL CHECK (job_type = ANY (ARRAY[
    'kds_dispatch'::text,
    'prep_start_whatsapp'::text
  ])),
  run_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY[
    'pending'::text, 'running'::text, 'completed'::text, 'cancelled'::text, 'failed'::text
  ])),
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT scheduled_jobs_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
  ON public.scheduled_jobs (run_at)
  WHERE status = 'pending';

-- ── walk_in_tokens: allow scheduled_takeaway ─────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.walk_in_tokens'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%type%'
  LOOP
    EXECUTE format('ALTER TABLE public.walk_in_tokens DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.walk_in_tokens
  ADD CONSTRAINT walk_in_tokens_type_check
  CHECK (type = ANY (ARRAY[
    'dinein'::text,
    'takeaway'::text,
    'large_party'::text,
    'scheduled_delivery'::text,
    'scheduled_takeaway'::text
  ]));

COMMENT ON COLUMN public.bookings.kitchen_start_at IS
  'Calculated time kitchen should begin prep for scheduled takeaway/delivery.';
COMMENT ON TABLE public.scheduled_jobs IS
  'DB-persisted jobs for KDS dispatch and prep-start WhatsApp (survives Railway restarts).';
