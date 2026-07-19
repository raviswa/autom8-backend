-- Allow walk_in_tokens.type = 'queue' for Token / Queue service.
-- Idempotent: drop+recreate check if present, else add.

DO $$
DECLARE
  con_name text;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON t.relnamespace = n.oid
  WHERE n.nspname = 'public'
    AND t.relname = 'walk_in_tokens'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%type%';

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.walk_in_tokens DROP CONSTRAINT %I', con_name);
  END IF;

  ALTER TABLE public.walk_in_tokens
    ADD CONSTRAINT walk_in_tokens_type_check
    CHECK (type IN (
      'dinein',
      'takeaway',
      'queue',
      'large_party',
      'scheduled_delivery',
      'scheduled_takeaway'
    ));
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;
