-- Outstation shipment / Shiprocket settings on tenants.
-- Safe to run multiple times (IF NOT EXISTS).

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shiprocket_connected boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shiprocket_api_key text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS intra_city_charge numeric;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS outstation_charge numeric;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS free_delivery_above numeric;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cod_enabled_city boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cod_enabled_outstation boolean NOT NULL DEFAULT false;
