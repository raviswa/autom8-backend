-- Shiprocket API User email (password stays in shiprocket_api_key).
-- Shiprocket auth requires email+password → JWT; a raw password as Bearer returns 401.
-- Safe to run multiple times.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS shiprocket_email text;

COMMENT ON COLUMN tenants.shiprocket_email IS
  'Shiprocket API User email (Settings → API). Password stored in shiprocket_api_key.';
