-- Fix walk_in_tokens.type for scheduled delivery manager approval.
--
-- PROBLEM: Supabase often has TWO type checks:
--   1) Original inline CHECK from CREATE TABLE (auto-named, e.g. walk_in_tokens_type_check)
--   2) A manually added walk_in_tokens_type_check with scheduled_delivery
-- INSERT fails until ALL old type checks are dropped.
--
-- Run in Supabase SQL Editor (project gedfgfwjofpjwfboyclu). Safe to re-run.

-- 1) List every CHECK on walk_in_tokens (inspect before/after)
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.walk_in_tokens'::regclass
  AND contype = 'c'
ORDER BY conname;

-- 2) If type is an enum, add the label (harmless if column is plain text)
DO $$
DECLARE
  col_type regtype;
BEGIN
  SELECT a.atttypid::regtype INTO col_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = 'walk_in_tokens'
    AND a.attname = 'type'
    AND NOT a.attisdropped
    AND n.nspname = 'public';

  IF col_type IS NOT NULL AND col_type::text LIKE '%enum%' THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      WHERE t.oid = col_type::oid AND e.enumlabel = 'scheduled_delivery'
    ) THEN
      EXECUTE format('ALTER TYPE %s ADD VALUE ''scheduled_delivery''', col_type);
    END IF;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3) Drop ALL check constraints that reference the type column
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

-- 4) Single canonical type check (queue + scheduled_delivery + scheduled_takeaway)
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

-- 5) Verify — must be exactly ONE type check, with scheduled_delivery
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.walk_in_tokens'::regclass
  AND contype = 'c'
  AND pg_get_constraintdef(oid) ILIKE '%type%';

-- 6) Live insert test (delete after)
INSERT INTO public.walk_in_tokens
  (id, restaurant_id, name, type, pax, status, meta)
VALUES
  (
    'T-MIGTEST',
    '46fb9b9e-431a-43c9-9edb-d316b0fef216',
    'test',
    'scheduled_delivery',
    1,
    'pending_approval',
    '{}'::jsonb
  );

DELETE FROM public.walk_in_tokens WHERE id = 'T-MIGTEST';
