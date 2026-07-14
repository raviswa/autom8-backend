-- Walk-in wait time estimation (static at token issuance).
-- Run once in Supabase SQL editor.

ALTER TABLE public.walk_in_tokens
  ADD COLUMN IF NOT EXISTS capacity_requested      INT  NULL,
  ADD COLUMN IF NOT EXISTS estimated_wait_minutes  INT  NULL,
  ADD COLUMN IF NOT EXISTS waitlist_depth_at_issue INT  NULL,
  ADD COLUMN IF NOT EXISTS estimate_display        TEXT NULL;

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS seated_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.walk_in_tokens.estimate_display IS
  'Static wait estimate shown at check-in, e.g. Approximately 25–35 minutes';
COMMENT ON COLUMN public.tables.seated_at IS
  'When the table was last seated (occupied); used for wait estimates';

-- Optional: shift default dining duration for new tenants (existing rows unchanged)
ALTER TABLE public.tenants
  ALTER COLUMN dining_duration_minutes SET DEFAULT 45;
