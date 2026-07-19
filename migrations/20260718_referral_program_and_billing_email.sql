-- Tenant referral program (tiered bonus days) + subscription payment ledger columns.
-- Additive / idempotent. No referral_program_config — tiers only.

BEGIN;

-- ── 1. Tier ladder (replaces any versioned config-row approach) ───────────────
CREATE TABLE IF NOT EXISTS public.referral_program_tiers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_order           int  NOT NULL UNIQUE,
  min_cumulative_count int  NOT NULL,
  bonus_days           int  NOT NULL,
  note                 text,
  created_at           timestamptz DEFAULT now()
);

COMMENT ON TABLE public.referral_program_tiers IS
  'Bonus days for new referrals, selected by highest min_cumulative_count <= live customer count.';

INSERT INTO public.referral_program_tiers (tier_order, min_cumulative_count, bonus_days, note)
VALUES
  (1,   0, 50, 'launch cohort'),
  (2,  25, 40, 'tier 2'),
  (3,  50, 30, 'tier 3'),
  (4,  75, 20, 'tier 4'),
  (5, 100, 15, 'steady state')
ON CONFLICT (tier_order) DO NOTHING;

-- ── 2. Polymorphic referrals (referrer always a tenant) ───────────────────────
CREATE TABLE IF NOT EXISTS public.tenant_referrals (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_restaurant_id uuid NOT NULL REFERENCES public.tenants(id),
  referred_type          text NOT NULL CHECK (referred_type IN ('tenant', 'supplier')),
  referred_id            uuid NOT NULL,
  bonus_days_snapshot    int  NOT NULL,
  status                 text NOT NULL DEFAULT 'pending',
  credited_at            timestamptz,
  created_by             text,
  created_at             timestamptz DEFAULT now(),
  UNIQUE (referred_type, referred_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_referrals_referrer
  ON public.tenant_referrals (referrer_restaurant_id);

CREATE INDEX IF NOT EXISTS idx_tenant_referrals_status
  ON public.tenant_referrals (status);

COMMENT ON TABLE public.tenant_referrals IS
  'Sales-led partner referrals. referred_id targets tenants or suppliers (no FK — validated in app).';
COMMENT ON COLUMN public.tenant_referrals.bonus_days_snapshot IS
  'bonus_days from the active tier at create time — never rewritten when tiers advance.';

-- ── 3. First inbound WhatsApp stamp (tenant activation for referrals) ────────
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS first_message_at timestamptz;

COMMENT ON COLUMN public.tenants.first_message_at IS
  'Set once on first inbound WhatsApp message for this tenant; triggers referral credit.';

-- ── 4. Subscription payment ledger (create if missing, then source columns) ──
CREATE TABLE IF NOT EXISTS public.tenant_subscription_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.tenants(id),
  amount        numeric(12, 2) NOT NULL DEFAULT 0,
  currency      text NOT NULL DEFAULT 'INR',
  source        text NOT NULL DEFAULT 'razorpay',
  reference_id  uuid,
  period_start  timestamptz,
  period_end    timestamptz,
  status        text NOT NULL DEFAULT 'completed',
  notes         text,
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE public.tenant_subscription_payments
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'razorpay';

ALTER TABLE public.tenant_subscription_payments
  ADD COLUMN IF NOT EXISTS reference_id uuid;

-- Mirrors supplier_subscription_payments.payment_link_url — src/helpers/billingReminders.js
-- queries this column for both entity types (loadPendingPaymentLink) at T-3/T0/T+5/T+10/T+15.
ALTER TABLE public.tenant_subscription_payments
  ADD COLUMN IF NOT EXISTS payment_link_url text;

COMMENT ON COLUMN public.tenant_subscription_payments.source IS
  'razorpay | referral_credit | manual_adjustment';
COMMENT ON COLUMN public.tenant_subscription_payments.reference_id IS
  'For referral_credit rows: tenant_referrals.id';

CREATE INDEX IF NOT EXISTS idx_tsp_restaurant
  ON public.tenant_subscription_payments (restaurant_id);

CREATE INDEX IF NOT EXISTS idx_tsp_source
  ON public.tenant_subscription_payments (restaurant_id, source);

-- NOTE: billing reminder dedup lives in subscription_reminders_sent
-- (migrations/20260718_subscription_billing_reminders.sql), not here — no
-- tenant_billing_notifications table is created by this migration.

-- ── 5. Atomic credit (subscription extend + ledger + referral status) ────────
CREATE OR REPLACE FUNCTION public.credit_referral_if_pending(
  p_referred_type text,
  p_referred_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref            public.tenant_referrals%ROWTYPE;
  v_sub            public.tenant_subscriptions%ROWTYPE;
  v_has_paid       boolean;
  v_period_start   timestamptz := now();
  v_period_end     timestamptz;
  v_bonus          int;
BEGIN
  IF p_referred_type IS NULL OR p_referred_id IS NULL THEN
    RETURN jsonb_build_object('credited', false, 'reason', 'invalid_args');
  END IF;

  SELECT * INTO v_ref
  FROM public.tenant_referrals
  WHERE referred_type = p_referred_type
    AND referred_id   = p_referred_id
    AND status        = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('credited', false, 'reason', 'no_pending');
  END IF;

  v_bonus := v_ref.bonus_days_snapshot;

  SELECT * INTO v_sub
  FROM public.tenant_subscriptions
  WHERE restaurant_id = v_ref.referrer_restaurant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'credited', false,
      'reason', 'referrer_subscription_missing',
      'referral_id', v_ref.id
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.tenant_subscription_payments
    WHERE restaurant_id = v_ref.referrer_restaurant_id
      AND source = 'razorpay'
  ) INTO v_has_paid;

  IF NOT v_has_paid THEN
    -- Trial / never-paid: extend from referred activation time when available,
    -- else from now.
    IF p_referred_type = 'tenant' THEN
      SELECT COALESCE(first_message_at, v_period_start)
        INTO v_period_start
      FROM public.tenants
      WHERE id = p_referred_id;
    END IF;

    v_period_end := v_period_start + make_interval(days => v_bonus);

    UPDATE public.tenant_subscriptions
    SET trial_ends_at = v_period_end,
        updated_at    = now()
    WHERE id = v_sub.id;
  ELSE
    v_period_start := now();
    v_period_end := COALESCE(v_sub.renews_at, now()) + make_interval(days => v_bonus);

    UPDATE public.tenant_subscriptions
    SET renews_at  = v_period_end,
        updated_at = now()
    WHERE id = v_sub.id;
  END IF;

  INSERT INTO public.tenant_subscription_payments (
    restaurant_id, amount, currency, source, reference_id,
    period_start, period_end, status, notes
  ) VALUES (
    v_ref.referrer_restaurant_id,
    0,
    'INR',
    'referral_credit',
    v_ref.id,
    v_period_start,
    v_period_end,
    'completed',
    format('Referral credit: %s days', v_bonus)
  );

  UPDATE public.tenant_referrals
  SET status      = 'credited',
      credited_at = now()
  WHERE id = v_ref.id;

  RETURN jsonb_build_object(
    'credited', true,
    'referral_id', v_ref.id,
    'referrer_restaurant_id', v_ref.referrer_restaurant_id,
    'bonus_days', v_bonus,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'extended_field', CASE WHEN v_has_paid THEN 'renews_at' ELSE 'trial_ends_at' END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.credit_referral_if_pending(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.credit_referral_if_pending(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.credit_referral_if_pending(text, uuid) TO postgres;

COMMIT;
