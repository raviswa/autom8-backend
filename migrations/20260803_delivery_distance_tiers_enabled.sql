-- Opt-in for km distance-based delivery charge tiers.
-- Default off: flat delivery_charge_default only.
-- Backfill enables the flag where merchants already configured tiers.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS delivery_distance_tiers_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenants.delivery_distance_tiers_enabled IS
  'When true, WhatsApp delivery fee uses delivery_charge_tiers by distance. When false, flat delivery_charge_default only.';

UPDATE public.tenants
SET delivery_distance_tiers_enabled = true
WHERE delivery_distance_tiers_enabled = false
  AND delivery_charge_tiers IS NOT NULL
  AND jsonb_typeof(delivery_charge_tiers::jsonb) = 'array'
  AND jsonb_array_length(delivery_charge_tiers::jsonb) > 0;
