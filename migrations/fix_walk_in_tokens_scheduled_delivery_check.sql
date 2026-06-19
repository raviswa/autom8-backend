-- Fix walk_in_tokens.type CHECK constraint to allow scheduled_delivery.
-- Error without this: violates check constraint "walk_in_tokens_type_check"
-- Run once in Supabase SQL editor (safe to re-run).

ALTER TABLE walk_in_tokens
  DROP CONSTRAINT IF EXISTS walk_in_tokens_type_check;

ALTER TABLE walk_in_tokens
  ADD CONSTRAINT walk_in_tokens_type_check
  CHECK (type IN ('dinein', 'takeaway', 'large_party', 'scheduled_delivery'));
