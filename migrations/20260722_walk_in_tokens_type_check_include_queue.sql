-- Canonical walk_in_tokens.type check — must include ALL app-accepted types:
--   dinein, takeaway, queue, large_party, delivery, scheduled_delivery, scheduled_takeaway
--
-- WHY: Older fix_walk_in_tokens_scheduled_* migrations recreated the check
-- WITHOUT 'queue', so Token/Queue inserts fail with walk_in_tokens_type_check
-- even though Node validates type=queue as valid. Door/courier orders also use type=delivery.
--
-- Run in Supabase SQL Editor. Safe to re-run.

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

-- 3) Single canonical type check
ALTER TABLE public.walk_in_tokens
  ADD CONSTRAINT walk_in_tokens_type_check
  CHECK (type = ANY (ARRAY[
    'dinein'::text,
    'takeaway'::text,
    'queue'::text,
    'large_party'::text,
    'delivery'::text,
    'scheduled_delivery'::text,
    'scheduled_takeaway'::text
  ]));

-- 4) Verify — expect exactly ONE row including queue + delivery + scheduled_*
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.walk_in_tokens'::regclass
  AND contype = 'c'
  AND pg_get_constraintdef(oid) ILIKE '%type%';

-- 5) Live insert smoke test for queue (delete after)
INSERT INTO public.walk_in_tokens
  (id, restaurant_id, name, type, pax, status, meta)
VALUES
  (
    'T-MIGTEST-QUEUE',
    '46fb9b9e-431a-43c9-9edb-d316b0fef216',
    'migration test',
    'queue',
    1,
    'waiting',
    '{}'::jsonb
  );

DELETE FROM public.walk_in_tokens WHERE id = 'T-MIGTEST-QUEUE';
