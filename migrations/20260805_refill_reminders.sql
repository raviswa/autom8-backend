-- Refill WhatsApp reminders (consumable food_products / retail).
-- Safe to run multiple times (IF NOT EXISTS).

ALTER TABLE public.menu_items
  ADD COLUMN IF NOT EXISTS days_to_empty integer;

COMMENT ON COLUMN public.menu_items.days_to_empty IS
  'Owner estimate of days before a unit typically runs out (refill reminders).';

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS refill_reminders_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS refill_lead_time_days integer NOT NULL DEFAULT 7;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS refill_safety_buffer_days integer NOT NULL DEFAULT 3;

COMMENT ON COLUMN public.tenants.refill_reminders_enabled IS
  'When true, create refill_cycles on paid orders and send WhatsApp reminders.';
COMMENT ON COLUMN public.tenants.refill_lead_time_days IS
  'Days before empty to remind (typical delivery lead time).';
COMMENT ON COLUMN public.tenants.refill_safety_buffer_days IS
  'Extra cushion days subtracted when computing reminder_due_at.';

CREATE TABLE IF NOT EXISTS public.refill_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES public.menu_items(id) ON DELETE SET NULL,
  retailer_id text,
  item_name text,
  booking_id uuid,
  customer_id uuid,
  customer_phone text NOT NULL,
  purchased_at timestamptz NOT NULL DEFAULT now(),
  days_to_empty integer NOT NULL,
  reminder_due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reminder_count integer NOT NULL DEFAULT 0,
  snooze_until timestamptz,
  last_reminded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refill_cycles_status_check CHECK (
    status = ANY (ARRAY[
      'pending'::text,
      'reminded'::text,
      'snoozed'::text,
      'reordered'::text,
      'dismissed'::text,
      'expired'::text
    ])
  )
);

CREATE INDEX IF NOT EXISTS idx_refill_cycles_due
  ON public.refill_cycles (restaurant_id, status, reminder_due_at);

CREATE INDEX IF NOT EXISTS idx_refill_cycles_customer_item
  ON public.refill_cycles (restaurant_id, customer_phone, retailer_id, status);

CREATE INDEX IF NOT EXISTS idx_refill_cycles_snooze
  ON public.refill_cycles (restaurant_id, status, snooze_until)
  WHERE status = 'snoozed';
