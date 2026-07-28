-- Allow PhonePe partnership intent before merchant ID is known.
-- Referral click creates a pending row with merchant_id NULL.

BEGIN;

ALTER TABLE public.tenant_payment_gateways
  ALTER COLUMN merchant_id DROP NOT NULL;

COMMENT ON COLUMN public.tenant_payment_gateways.merchant_id IS
  'PhonePe merchant ID (MID) for this Autom8 outlet. Null = referral intent clicked, MID not yet reported.';

COMMIT;
