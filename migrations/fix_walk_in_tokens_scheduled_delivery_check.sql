-- REQUIRED for scheduled delivery manager approval.
-- Run in Supabase SQL Editor → project gedfgfwjofpjwfboyclu (same DB as chat + api.autom8.works).
-- Safe to re-run. After running, you MUST see scheduled_delivery in the output of step 4.

-- ── 1) Inspect current type column + constraints (read-only) ─────────────────
SELECT column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'walk_in_tokens'
  AND column_name = 'type';

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.walk_in_tokens'::regclass
  AND contype = 'c'
ORDER BY conname;

-- ── 2) If type is a PostgreSQL enum, add the new label ───────────────────────
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
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      WHERE t.oid = col_type::oid
        AND e.enumlabel = 'scheduled_delivery'
    ) THEN
      EXECUTE format('ALTER TYPE %s ADD VALUE ''scheduled_delivery''', col_type);
      RAISE NOTICE 'Added enum value scheduled_delivery to %', col_type;
    END IF;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── 3) Replace CHECK constraint (this is what blocks inserts today) ───────────
ALTER TABLE public.walk_in_tokens
  DROP CONSTRAINT IF EXISTS walk_in_tokens_type_check;

ALTER TABLE public.walk_in_tokens
  ADD CONSTRAINT walk_in_tokens_type_check
  CHECK (type::text IN ('dinein', 'takeaway', 'large_party', 'scheduled_delivery'));

-- ── 4) Verify — must include scheduled_delivery or migration did not apply ───
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conrelid = 'public.walk_in_tokens'::regclass
    AND conname = 'walk_in_tokens_type_check';

  IF def IS NULL THEN
    RAISE EXCEPTION 'MIGRATION FAILED: walk_in_tokens_type_check missing after ALTER';
  END IF;

  IF def NOT LIKE '%scheduled_delivery%' THEN
    RAISE EXCEPTION 'MIGRATION FAILED: constraint still excludes scheduled_delivery: %', def;
  END IF;

  RAISE NOTICE 'SUCCESS — walk_in_tokens_type_check now allows scheduled_delivery: %', def;
END $$;

-- ── 5) Dry-run insert (rolls back — proves inserts work) ────────────────────
BEGIN;
INSERT INTO public.walk_in_tokens
  (id, restaurant_id, name, phone, type, pax, status, meta)
VALUES
  (
    '__sched_delivery_migration_test__',
    '46fb9b9e-431a-43c9-9edb-d316b0fef216',
    'Migration test',
    NULL,
    'scheduled_delivery',
    1,
    'pending_approval',
    '{}'::jsonb
  );
ROLLBACK;
