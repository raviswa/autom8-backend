-- Monthly portal token sequence (IST calendar month).
-- Allocates 1, 2, 3… every new order regardless of prior token status; resets each month.
-- Token IDs: T-YYMM-001 (e.g. T-2506-001 for June 2026).
-- Run once in Supabase SQL editor after add_portal_token_sequence.sql.

ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS portal_token_seq_month text;

COMMENT ON COLUMN public.restaurants.portal_token_seq_month IS
  'IST YYYY-MM for portal_token_seq; when month changes the counter resets to 0 before next allocate.';

-- Reset counter when IST month rolls over; always increment (never skip for cancelled/superseded).
CREATE OR REPLACE FUNCTION public.allocate_portal_token_seq(p_restaurant_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_month text;
  v_next integer;
BEGIN
  v_month := to_char((now() AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM');

  UPDATE public.restaurants
  SET
    portal_token_seq = CASE
      WHEN portal_token_seq_month IS DISTINCT FROM v_month THEN 1
      ELSE portal_token_seq + 1
    END,
    portal_token_seq_month = v_month
  WHERE id = p_restaurant_id
  RETURNING portal_token_seq INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'restaurant % not found', p_restaurant_id;
  END IF;

  RETURN v_next;
END;
$$;
