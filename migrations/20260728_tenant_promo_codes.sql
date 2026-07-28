-- Tenant (restaurant/LOB) customer promo codes for webcart shoppers.
-- Separate from platform subscription_offers (₹1000/mo).

BEGIN;

CREATE TABLE IF NOT EXISTS public.tenant_promo_codes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code              text NOT NULL,
  discount_type     text NOT NULL CHECK (discount_type IN ('percent', 'flat')),
  discount_value    numeric(12, 2) NOT NULL CHECK (discount_value >= 0),
  min_order_amount  numeric(12, 2),
  max_redemptions   integer,
  redemption_count  integer NOT NULL DEFAULT 0,
  valid_from        timestamptz,
  valid_until       timestamptz,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  UNIQUE (restaurant_id, code)
);

CREATE INDEX IF NOT EXISTS tenant_promo_codes_restaurant_idx
  ON public.tenant_promo_codes (restaurant_id);

CREATE INDEX IF NOT EXISTS tenant_promo_codes_active_idx
  ON public.tenant_promo_codes (restaurant_id, is_active)
  WHERE is_active = true;

COMMENT ON TABLE public.tenant_promo_codes IS
  'Restaurant/LOB-created promo codes for webcart shoppers. Not platform subscription offers.';

-- Optional redemption audit trail (order linkage)
CREATE TABLE IF NOT EXISTS public.tenant_promo_redemptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id   uuid NOT NULL REFERENCES public.tenant_promo_codes(id) ON DELETE CASCADE,
  restaurant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  order_id        uuid,
  customer_phone  text,
  discount_amount numeric(12, 2) NOT NULL DEFAULT 0,
  code_snapshot   text NOT NULL,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_promo_redemptions_promo_idx
  ON public.tenant_promo_redemptions (promo_code_id, created_at DESC);

CREATE INDEX IF NOT EXISTS tenant_promo_redemptions_restaurant_idx
  ON public.tenant_promo_redemptions (restaurant_id, created_at DESC);

COMMIT;
