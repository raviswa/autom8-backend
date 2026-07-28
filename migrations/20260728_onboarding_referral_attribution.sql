-- Onboarding referral attribution + additive free-month credit.
-- Idempotent. Safe to re-run.

BEGIN;

-- ── 1. Attribution columns on tenants ────────────────────────────────────────
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS referral_source text;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS referrer_waba text;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS referred_by_restaurant_id uuid REFERENCES public.tenants(id);

COMMENT ON COLUMN public.tenants.referral_source IS
  'Self-serve signup attribution: existing_owner | sales | google | social | friend | other';
COMMENT ON COLUMN public.tenants.referrer_waba IS
  'Raw/normalized WABA digits entered when referral_source = existing_owner';
COMMENT ON COLUMN public.tenants.referred_by_restaurant_id IS
  'Resolved referrer tenant when WABA matched an existing active outlet';

CREATE INDEX IF NOT EXISTS idx_tenants_referred_by
  ON public.tenants (referred_by_restaurant_id)
  WHERE referred_by_restaurant_id IS NOT NULL;

-- ── 2. Additive credit + PhonePe-aware paid detection ─────────────────────────
-- Trial path previously SET trial_ends_at = period_start + bonus (replace).
-- Now ADD bonus days onto COALESCE(trial_ends_at, now()) so referrers get a
-- true free month without shortening an existing trial window.
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
      AND status = 'completed'
      AND source IN ('razorpay', 'phonepe')
  ) INTO v_has_paid;

  IF NOT v_has_paid THEN
    v_period_start := COALESCE(v_sub.trial_ends_at, now());
    IF v_period_start < now() THEN
      v_period_start := now();
    END IF;
    v_period_end := v_period_start + make_interval(days => v_bonus);

    UPDATE public.tenant_subscriptions
    SET trial_ends_at = v_period_end,
        updated_at    = now()
    WHERE id = v_sub.id;
  ELSE
    v_period_start := now();
    v_period_end := COALESCE(v_sub.renews_at, now()) + make_interval(days => v_bonus);
    IF v_sub.renews_at IS NOT NULL AND v_sub.renews_at > now() THEN
      v_period_end := v_sub.renews_at + make_interval(days => v_bonus);
    END IF;

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
    format('Referral credit: %s days (free month)', v_bonus)
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
