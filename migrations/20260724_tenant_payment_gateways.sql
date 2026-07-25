-- Per-tenant payment gateway registry (PhonePe partnership tracking).
-- Stores merchant identifiers only — no salt keys, no end-customer PII.

CREATE TABLE IF NOT EXISTS public.tenant_payment_gateways (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id         uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider              text NOT NULL DEFAULT 'phonepe'
                          CHECK (provider IN ('phonepe')),
  merchant_id           text NOT NULL,
  merchant_name         text,
  partner_referral_code text,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'live', 'kyc_failed', 'inactive')),
  linked_at             timestamptz,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, provider)
);

CREATE INDEX IF NOT EXISTS tenant_payment_gateways_merchant_id_idx
  ON public.tenant_payment_gateways (provider, merchant_id);

CREATE INDEX IF NOT EXISTS tenant_payment_gateways_status_idx
  ON public.tenant_payment_gateways (provider, status);

COMMENT ON TABLE public.tenant_payment_gateways IS
  'Client payment-gateway merchant registry for partnership/audit (e.g. PhonePe MID). No secrets.';

COMMENT ON COLUMN public.tenant_payment_gateways.merchant_id IS
  'PhonePe merchant ID (MID) for this Autom8 outlet';

COMMENT ON COLUMN public.tenant_payment_gateways.partner_referral_code IS
  'Autom8/PhonePe partnership referral or partner code, if any';

COMMENT ON COLUMN public.tenant_payment_gateways.status IS
  'pending | live | kyc_failed | inactive';
