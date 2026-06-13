-- Per-restaurant WhatsApp / Meta config (replaces Railway env vars for tenants).
-- Run once in Supabase SQL editor after add_restaurant_kitchen_settings.sql.

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS meta_catalog_id text;

COMMENT ON COLUMN restaurants.meta_catalog_id IS
  'Meta Commerce catalog ID for WhatsApp catalog sync and catalog messages';

-- phone_number_id + access_token live in restaurant_integrations (already exists).
-- manager_phone + whatsapp_number + waba_id live on restaurants (already exists).

-- ── Backfill Munafe demo outlet ─────────────────────────────────────────────
-- Replace placeholders with values currently in Railway env vars, then run:

-- UPDATE restaurants
-- SET
--   meta_catalog_id = '<META_CATALOG_ID from Railway>',
--   manager_phone   = COALESCE(manager_phone, '<MANAGER_WHATSAPP_NUMBER>'),
--   whatsapp_number = COALESCE(whatsapp_number, '<display phone E.164 digits>')
-- WHERE id = '46fb9b9e-431a-43c9-9edb-d316b0fef216';

-- INSERT INTO restaurant_integrations (
--   restaurant_id, provider, channel, phone_number_id, access_token, is_active
-- )
-- SELECT
--   '46fb9b9e-431a-43c9-9edb-d316b0fef216',
--   'meta', 'whatsapp',
--   '<WHATSAPP_PHONE_NUMBER_ID or BOTBIZ_PHONE_NUMBER_ID>',
--   '<WHATSAPP_ACCESS_TOKEN or BOTBIZ_ACCESS_TOKEN>',
--   true
-- WHERE NOT EXISTS (
--   SELECT 1 FROM restaurant_integrations
--   WHERE restaurant_id = '46fb9b9e-431a-43c9-9edb-d316b0fef216'
--     AND provider = 'meta' AND channel = 'whatsapp'
-- );
