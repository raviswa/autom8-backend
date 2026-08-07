-- Autom8 Meta utility disclosure + optional buyer platform charge pass-through.
-- Defaults keep existing checkout totals unchanged until merchant opts in.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS platform_charge_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS platform_charge_conversation numeric(10, 2) NOT NULL DEFAULT 1.00;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS platform_charge_per_order numeric(10, 2) NOT NULL DEFAULT 2.00;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS disclosure_accepted_at timestamptz NULL;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS disclosure_version text NULL;

COMMENT ON COLUMN tenants.platform_charge_enabled IS
  'When true, webcart adds Autom8 platform charge (₹1 conversation / ₹2 restaurant order) after GST.';
COMMENT ON COLUMN tenants.platform_charge_conversation IS
  'Minimal/utility conversation pass-through amount (INR), default 1.00.';
COMMENT ON COLUMN tenants.platform_charge_per_order IS
  'Restaurant/cloud_kitchen per-order pass-through amount (INR), default 2.00.';
COMMENT ON COLUMN tenants.disclosure_accepted_at IS
  'Server timestamp when merchant accepted current Meta utility cost disclosure.';
COMMENT ON COLUMN tenants.disclosure_version IS
  'Version string of accepted disclosure wording; must match backend constant to enable charge.';
