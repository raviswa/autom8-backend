-- Add walk_in_tokens.type = 'scheduled_takeaway' to the canonical type check.
-- Run in Supabase SQL Editor after scheduled_delivery is already allowed.
-- Safe to re-run.

-- 1) Inspect current type checks
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.walk_in_tokens'::regclass
  AND contype = 'c'
ORDER BY conname;

-- 2) Drop every CHECK that references type
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.walk_in_tokens'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%type%'
  LOOP
    EXECUTE format('ALTER TABLE public.walk_in_tokens DROP CONSTRAINT %I', r.conname);
    RAISE NOTICE 'Dropped constraint %', r.conname;
  END LOOP;
END $$;

-- 3) Single canonical type check (delivery + takeaway scheduling)
ALTER TABLE public.walk_in_tokens
  ADD CONSTRAINT walk_in_tokens_type_check
  CHECK (type = ANY (ARRAY[
    'dinein'::text,
    'takeaway'::text,
    'large_party'::text,
    'scheduled_delivery'::text,
    'scheduled_takeaway'::text
  ]));

-- 4) Verify — expect exactly ONE row including scheduled_takeaway
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.walk_in_tokens'::regclass
  AND contype = 'c'
  AND pg_get_constraintdef(oid) ILIKE '%type%';

-- 5) Live insert test (rolls back via delete)
INSERT INTO public.walk_in_tokens
  (id, restaurant_id, name, type, pax, status, meta)
VALUES
  (
    'T-MIGTEST-TAKEAWAY',
    (SELECT id FROM public.tenants WHERE is_active = true LIMIT 1),
    'migration test',
    'scheduled_takeaway',
    1,
    'pending_approval',
    '{}'::jsonb
  );

DELETE FROM public.walk_in_tokens WHERE id = 'T-MIGTEST-TAKEAWAY';
