-- Subscription offers (self-serve promo codes) + PhonePe billing support
-- Separate from referral_program_tiers / tenant_referrals (automatic bonus days).
-- Self-contained: creates tenant_subscription_payments if the earlier
-- 20260718 migration was never applied on this database.

CREATE TABLE IF NOT EXISTS public.subscription_offers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text UNIQUE NOT NULL,
  discount_type     text NOT NULL CHECK (discount_type IN ('percent', 'flat')),
  discount_value    numeric NOT NULL,
  applies_to_lob    text[],
  valid_from        timestamptz,
  valid_until       timestamptz,
  max_redemptions   integer,
  redemption_count  integer NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscription_offers_code_idx
  ON public.subscription_offers (lower(code));

COMMENT ON TABLE public.subscription_offers IS
  'Self-serve promo codes for ₹1000/mo flat subscription. Not the referral bonus-days system.';

-- Payment ledger (create if missing — required before ALTER COLUMN below)
CREATE TABLE IF NOT EXISTS public.tenant_subscription_payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id      uuid NOT NULL REFERENCES public.tenants(id),
  amount             numeric(12, 2) NOT NULL DEFAULT 0,
  currency           text NOT NULL DEFAULT 'INR',
  source             text NOT NULL DEFAULT 'phonepe',
  reference_id       uuid,
  external_reference text,
  offer_code         text,
  period_start       timestamptz,
  period_end         timestamptz,
  status             text NOT NULL DEFAULT 'completed',
  notes              text,
  payment_link_url   text,
  created_at         timestamptz DEFAULT now()
);

-- Idempotent column adds for DBs that already had a thinner ledger table
ALTER TABLE public.tenant_subscription_payments
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'phonepe';

ALTER TABLE public.tenant_subscription_payments
  ADD COLUMN IF NOT EXISTS reference_id uuid;

ALTER TABLE public.tenant_subscription_payments
  ADD COLUMN IF NOT EXISTS payment_link_url text;

ALTER TABLE public.tenant_subscription_payments
  ADD COLUMN IF NOT EXISTS external_reference text;

ALTER TABLE public.tenant_subscription_payments
  ADD COLUMN IF NOT EXISTS offer_code text;

CREATE INDEX IF NOT EXISTS idx_tsp_restaurant
  ON public.tenant_subscription_payments (restaurant_id);

CREATE INDEX IF NOT EXISTS idx_tsp_source
  ON public.tenant_subscription_payments (restaurant_id, source);

CREATE INDEX IF NOT EXISTS idx_tsp_external_reference
  ON public.tenant_subscription_payments (external_reference);

COMMENT ON COLUMN public.tenant_subscription_payments.external_reference IS
  'Gateway merchant transaction / order id (e.g. PhonePe merchantTransactionId)';

COMMENT ON COLUMN public.tenant_subscription_payments.source IS
  'phonepe | razorpay | referral_credit | manual_adjustment';

COMMENT ON COLUMN public.tenant_subscription_payments.reference_id IS
  'For referral_credit rows: tenant_referrals.id';

-- Flag: Graph /register needs the number's existing 2FA PIN (migration case)
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS whatsapp_needs_existing_pin boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenants.whatsapp_needs_existing_pin IS
  'True when Embedded Signup linked credentials but Meta register needs the prior 2FA PIN';

-- Remember last applied offer on the subscription row (only if table exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'tenant_subscriptions'
  ) THEN
    ALTER TABLE public.tenant_subscriptions
      ADD COLUMN IF NOT EXISTS applied_offer_code text;
  END IF;
END $$;
