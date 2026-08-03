-- Per-tenant customer checkout gateway preference (platform credentials).
-- phonepe = default for new tenants; razorpay = existing Razorpay-era outlets.
-- Null = fall back to chat PAYMENT_GATEWAY env (then PhonePe→Razorpay fallback).

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS payment_provider text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tenants_payment_provider_check'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_payment_provider_check
      CHECK (
        payment_provider IS NULL
        OR payment_provider IN ('phonepe', 'razorpay')
      );
  END IF;
END $$;

COMMENT ON COLUMN public.tenants.payment_provider IS
  'Customer order checkout preference: phonepe | razorpay. Null = platform default. Does not store secrets.';

-- Ops backfill example (replace UUIDs with known Razorpay-era outlets):
-- UPDATE public.tenants
-- SET payment_provider = 'razorpay'
-- WHERE id IN (
--   'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
-- );
--
-- Or: prefer razorpay where no live PhonePe MID is registered:
-- UPDATE public.tenants t
-- SET payment_provider = 'razorpay'
-- WHERE t.payment_provider IS NULL
--   AND NOT EXISTS (
--     SELECT 1 FROM public.tenant_payment_gateways g
--     WHERE g.restaurant_id = t.id
--       AND g.provider = 'phonepe'
--       AND g.status = 'live'
--       AND COALESCE(g.merchant_id, '') <> ''
--   );
