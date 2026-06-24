-- Monotonic portal token IDs (T-001, T-002, …) — never reuse once allocated.
-- Run once in Supabase SQL editor.

ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS portal_token_seq integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.restaurants.portal_token_seq IS
  'Last allocated walk_in_tokens portal id sequence; incremented atomically per new token.';

-- Seed from existing tokens so new allocations never collide with history.
UPDATE public.restaurants r
SET portal_token_seq = GREATEST(
  r.portal_token_seq,
  COALESCE((
    SELECT MAX((regexp_match(wt.id, '^T-(\d+)$'))[1]::integer)
    FROM public.walk_in_tokens wt
    WHERE wt.restaurant_id = r.id
      AND wt.id ~ '^T-[0-9]+$'
  ), 0)
);

CREATE OR REPLACE FUNCTION public.allocate_portal_token_seq(p_restaurant_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_next integer;
BEGIN
  UPDATE public.restaurants
  SET portal_token_seq = portal_token_seq + 1
  WHERE id = p_restaurant_id
  RETURNING portal_token_seq INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'restaurant % not found', p_restaurant_id;
  END IF;

  RETURN v_next;
END;
$$;
