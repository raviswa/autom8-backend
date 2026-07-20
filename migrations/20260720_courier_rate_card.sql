-- Configurable shipping provider for packaged LOBs (food_products / retail / psl).
-- Default remains Shiprocket; providers may switch to a custom courier rate card
-- (weight slabs × zones: local, within_state, metro, rest_of_india, special).
-- Safe to run multiple times.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS shipping_provider text NOT NULL DEFAULT 'shiprocket';

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS courier_name text;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS courier_rate_card jsonb;

COMMENT ON COLUMN tenants.shipping_provider IS
  'shiprocket (default live rates) | custom (courier_rate_card by weight + zone)';
COMMENT ON COLUMN tenants.courier_name IS
  'Display name when shipping_provider = custom, e.g. XXX Couriers';
COMMENT ON COLUMN tenants.courier_rate_card IS
  'JSON: { weight_slabs_kg, rates[slab][zone], additional_per_kg[zone] }';
