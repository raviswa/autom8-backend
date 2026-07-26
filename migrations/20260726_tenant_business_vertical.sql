-- Safe to run multiple times.
-- Brochure family + vertical labels for tenants (schema behavior still uses lob_type).

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS business_family TEXT;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS business_vertical TEXT;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS business_vertical_other TEXT;

COMMENT ON COLUMN tenants.business_family IS
  'Brochure LOB family: restaurant (Food & Beverages) | retail | b2b | other. Portal chrome and copy.';

COMMENT ON COLUMN tenants.business_vertical IS
  'Brochure vertical id within the family (e.g. food_products, fashion_jewellery).';

COMMENT ON COLUMN tenants.business_vertical_other IS
  'Merchant-supplied description, set only when the chosen vertical is an "Others" option.';

CREATE INDEX IF NOT EXISTS idx_tenants_business_family
  ON tenants (business_family)
  WHERE business_family IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenants_business_vertical
  ON tenants (business_vertical)
  WHERE business_vertical IS NOT NULL;
