-- Allow walk_in_tokens.type = 'delivery' for door/courier shipped orders.
-- Safe to re-run. Follows 20260722_walk_in_tokens_type_check_include_queue.sql.

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
  END LOOP;
END $$;

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
