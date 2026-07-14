-- Receipt header fields for GST / FSSAI / SAC on WhatsApp PNG bills.
-- Run once in Supabase SQL editor.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS fssai_license   text,
  ADD COLUMN IF NOT EXISTS sac_code        text DEFAULT '996331',
  ADD COLUMN IF NOT EXISTS receipt_tagline text;

COMMENT ON COLUMN public.tenants.fssai_license IS
  'FSSAI licence number printed on customer receipts';

COMMENT ON COLUMN public.tenants.sac_code IS
  'SAC code for GST invoices (default 996331 = restaurant/catering services)';

COMMENT ON COLUMN public.tenants.receipt_tagline IS
  'Optional subtitle under restaurant name on receipts (e.g. franchise line)';
