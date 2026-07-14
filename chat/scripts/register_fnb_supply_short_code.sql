-- Munafe Supply on the shared WABA: customers message "Hi fnb" to start B2B supply chat.
-- Run in Supabase SQL editor after replacing :supply_tenant_id with your supply supplier row.

-- 1) Point the supply tenant at keyword "fnb" on the same WhatsApp number as Munafe/PSL.
UPDATE tenants
SET
  short_code            = 'fnb',
  lob_type              = 'supply',
  is_default_for_number = false
WHERE id = ':supply_tenant_id'
  AND is_active = true;

-- 2) Verify active keywords on the shared number (should list munafe, psl, fnb).
-- SELECT short_code, lob_type, display_name, whatsapp_number
-- FROM tenants
-- WHERE is_active = true
--   AND short_code IS NOT NULL
-- ORDER BY sort_order NULLS FIRST;

-- 3) Ensure the test handset exists as a supply client for that supplier.
-- INSERT INTO supply_clients (supplier_id, name, phone, is_active)
-- VALUES (':supply_tenant_id', 'Test Client', '917305362067', true)
-- ON CONFLICT DO NOTHING;
