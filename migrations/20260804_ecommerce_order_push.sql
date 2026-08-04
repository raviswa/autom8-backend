-- Ecommerce order push: bookings.external_order_id + unique ecommerce integrations
-- Safe to run multiple times.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS external_order_id text;

CREATE INDEX IF NOT EXISTS idx_bookings_external_order_id
  ON public.bookings (external_order_id)
  WHERE external_order_id IS NOT NULL;

COMMENT ON COLUMN public.bookings.external_order_id IS
  'Primary Shopify/WooCommerce/etc. order id from Munafe ecommerce push (first success). Multi-platform detail in meta.ecommerce_pushes.';

-- One ecommerce integration row per provider per restaurant.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_integrations_ecommerce_provider_uidx
  ON public.tenant_integrations (restaurant_id, provider)
  WHERE channel = 'ecommerce';
