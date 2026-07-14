-- Optional thermal printer settings per restaurant (run in Supabase SQL editor)
-- Browser KOT on the KDS screen works without these columns.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS kot_printer_ip       text,
  ADD COLUMN IF NOT EXISTS kot_printer_port     integer DEFAULT 9100,
  ADD COLUMN IF NOT EXISTS kot_printer_enabled  boolean DEFAULT false;

COMMENT ON COLUMN tenants.kot_printer_ip IS 'LAN IP of ESC/POS thermal printer (e.g. 192.168.1.100). API must reach this IP.';
COMMENT ON COLUMN tenants.kot_printer_port IS 'Raw TCP port, usually 9100 for network thermal printers.';
COMMENT ON COLUMN tenants.kot_printer_enabled IS 'When true and workflow includes KOT, server attempts network print after KDS notify.';
