-- Run once in Supabase SQL editor (Dashboard → SQL → New query)
-- Fixes: [dashboard/waba] column tenants.kitchen_workflow does not exist

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS kitchen_workflow text DEFAULT 'KOT_only',
  ADD COLUMN IF NOT EXISTS kot_printer_ip text,
  ADD COLUMN IF NOT EXISTS kot_printer_port integer DEFAULT 9100,
  ADD COLUMN IF NOT EXISTS kot_printer_enabled boolean DEFAULT false;

COMMENT ON COLUMN tenants.kitchen_workflow IS 'KOT_only | KDS_only | Both_KOT_and_KDS';
COMMENT ON COLUMN tenants.kot_printer_ip IS 'Optional LAN ESC/POS printer IP';
COMMENT ON COLUMN tenants.kot_printer_port IS 'Thermal printer TCP port (default 9100)';
COMMENT ON COLUMN tenants.kot_printer_enabled IS 'Server-side network KOT when true';

-- Set demo restaurant to hybrid if unset
UPDATE tenants
SET kitchen_workflow = 'Both_KOT_and_KDS'
WHERE kitchen_workflow IS NULL OR kitchen_workflow = 'KOT_only';
