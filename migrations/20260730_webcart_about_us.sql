-- Optional webcart "About Us" tab (tenant opt-in).
-- Reuses existing profile columns (logo, address, contact, FSSAI, website, Instagram);
-- these columns only gate visibility and store About-specific extras.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS about_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS about_note text;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS inception_date date;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS social_links jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN tenants.about_enabled IS
  'When true and at least one About field is filled, webcart shows an About tab.';
COMMENT ON COLUMN tenants.about_note IS
  'Short customer-facing bio for the webcart About tab (cap ~150 chars in API).';
COMMENT ON COLUMN tenants.inception_date IS
  'Business start date (month precision OK as YYYY-MM-01); used to compute years in business.';
COMMENT ON COLUMN tenants.social_links IS
  'JSON array of {platform, url} for About tab social links (open in new tab).';
