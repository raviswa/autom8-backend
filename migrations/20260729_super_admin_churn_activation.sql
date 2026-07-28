-- Super admin console: activation events, churn outreach, admin audit, activity view.

BEGIN;

-- ── Attribution extras (referral_source already exists) ───────────────────────
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS signup_source_detail text,
  ADD COLUMN IF NOT EXISTS utm_source text,
  ADD COLUMN IF NOT EXISTS utm_campaign text;

COMMENT ON COLUMN public.tenants.signup_source_detail IS
  'Free-text detail for referral_source (referrer name, campaign note, etc.)';
COMMENT ON COLUMN public.tenants.utm_source IS 'UTM source captured at registration';
COMMENT ON COLUMN public.tenants.utm_campaign IS 'UTM campaign captured at registration';

-- ── Activation event log ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tenant_activation_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS tenant_activation_events_tenant_type_idx
  ON public.tenant_activation_events (tenant_id, event_type);

CREATE INDEX IF NOT EXISTS tenant_activation_events_occurred_idx
  ON public.tenant_activation_events (occurred_at DESC);

-- First occurrence of each event type per tenant (optional uniqueness for idempotent firsts)
CREATE UNIQUE INDEX IF NOT EXISTS tenant_activation_events_first_of_type_uidx
  ON public.tenant_activation_events (tenant_id, event_type)
  WHERE event_type IN (
    'signed_up', 'welcome_email_sent', 'catalog_uploaded', 'fssai_verified',
    'first_login', 'whatsapp_connected', 'first_order', 'trial_started',
    'subscription_activated'
  );

COMMENT ON TABLE public.tenant_activation_events IS
  'Onboarding / activation timeline events for Autom8 Works super-admin console';

-- ── Activity rollup view (orders.restaurant_id) ───────────────────────────────
CREATE OR REPLACE VIEW public.tenant_activity AS
SELECT
  t.id AS tenant_id,
  t.lob_type,
  t.is_active,
  max(o.created_at) FILTER (
    WHERE o.status IS DISTINCT FROM 'cancelled'
  ) AS last_order_at,
  count(o.id) FILTER (
    WHERE o.status IS DISTINCT FROM 'cancelled'
  ) AS lifetime_orders,
  CASE
    WHEN max(o.created_at) FILTER (WHERE o.status IS DISTINCT FROM 'cancelled') IS NULL
      THEN NULL
    ELSE (now() - max(o.created_at) FILTER (WHERE o.status IS DISTINCT FROM 'cancelled'))
  END AS idle_interval
FROM public.tenants t
LEFT JOIN public.orders o ON o.restaurant_id = t.id
GROUP BY t.id, t.lob_type, t.is_active;

COMMENT ON VIEW public.tenant_activity IS
  'Per-tenant last order / lifetime order counts for churn detection';

-- ── LOB idle thresholds ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.churn_idle_thresholds (
  lob_type   text PRIMARY KEY,
  idle_days  integer NOT NULL CHECK (idle_days > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.churn_idle_thresholds (lob_type, idle_days) VALUES
  ('restaurant', 21),
  ('food_products', 21),
  ('retail', 30),
  ('jewellery', 30),
  ('psl', 30),
  ('b2b', 45),
  ('b2b_supply', 45),
  ('default', 30)
ON CONFLICT (lob_type) DO NOTHING;

-- ── Churn outreach dedup ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.churn_outreach_sent (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  outreach_type text NOT NULL,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, outreach_type)
);

CREATE INDEX IF NOT EXISTS churn_outreach_sent_tenant_idx
  ON public.churn_outreach_sent (tenant_id);

-- ── Churn feedback (tap-a-reason) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.churn_feedback (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  reason       text NOT NULL,
  note         text,
  submitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS churn_feedback_tenant_idx
  ON public.churn_feedback (tenant_id);
CREATE INDEX IF NOT EXISTS churn_feedback_reason_idx
  ON public.churn_feedback (reason);

-- ── Admin action audit ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_action_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_role   text NOT NULL,
  actor_label  text,
  action_type  text NOT NULL,
  tenant_id    uuid REFERENCES public.tenants(id) ON DELETE SET NULL,
  reason       text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS admin_action_log_tenant_idx
  ON public.admin_action_log (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS admin_action_log_occurred_idx
  ON public.admin_action_log (occurred_at DESC);

COMMIT;
