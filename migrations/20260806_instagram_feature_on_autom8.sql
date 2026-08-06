-- Opt-in: feature subscriber Instagram promo posts on Autom8 Works (branded repost).
-- Default OFF — Consent must be explicit before parallel mirror publishing.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS instagram_feature_on_autom8 boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.instagram_feature_on_autom8 IS
  'When true, successful Confirm & publish may mirror a branded repost to Autom8 Works IG. Opt-in only.';
