-- Subscription billing reminder dedup + supplier subscription tables (if missing).
-- Soft-lock / reminder grace is driven by SUBSCRIPTION_GRACE_PERIOD_DAYS (default 15)
-- in application code; at T+15 status is set to past_due (tenants) / overdue (suppliers).

BEGIN;

-- ── Dedup log: one row per entity × reminder × billing cycle anchor ───────────
CREATE TABLE IF NOT EXISTS public.subscription_reminders_sent (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     text NOT NULL CHECK (entity_type IN ('tenant', 'supplier')),
  entity_id       uuid NOT NULL,
  subscription_id uuid NOT NULL,
  reminder_type   text NOT NULL,
  cycle_anchor    date NOT NULL,
  sent_at         timestamptz DEFAULT now(),
  UNIQUE (entity_type, entity_id, reminder_type, cycle_anchor)
);

CREATE INDEX IF NOT EXISTS idx_srs_entity
  ON public.subscription_reminders_sent (entity_type, entity_id);

COMMENT ON TABLE public.subscription_reminders_sent IS
  'Dedup for SaaS billing reminders (tenant + supplier). cycle_anchor = date(trial_ends_at|renews_at).';

-- ── Supplier subscriptions (parallel to tenant_subscriptions) ─────────────────
CREATE TABLE IF NOT EXISTS public.supplier_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id   uuid NOT NULL UNIQUE REFERENCES public.suppliers(id),
  status        text NOT NULL DEFAULT 'trial',
  trial_ends_at timestamptz,
  renews_at     timestamptz,
  base_price    numeric NOT NULL DEFAULT 1000,
  final_price   numeric NOT NULL DEFAULT 1000,
  billing_cycle text NOT NULL DEFAULT 'monthly',
  created_at    timestamptz DEFAULT now()
);

COMMENT ON COLUMN public.supplier_subscriptions.status IS
  'trial | active | overdue | cancelled — overdue mirrors tenant past_due';

CREATE TABLE IF NOT EXISTS public.supplier_subscription_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id         uuid NOT NULL REFERENCES public.suppliers(id),
  subscription_id     uuid NOT NULL REFERENCES public.supplier_subscriptions(id),
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  amount              numeric NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  source              text NOT NULL DEFAULT 'razorpay',
  reference_id        uuid,
  razorpay_link_id    text,
  razorpay_payment_id text,
  payment_link_url    text,
  paid_at             timestamptz,
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ssp_supplier
  ON public.supplier_subscription_payments (supplier_id);

CREATE INDEX IF NOT EXISTS idx_ssp_razorpay_link
  ON public.supplier_subscription_payments (razorpay_link_id);

COMMIT;
