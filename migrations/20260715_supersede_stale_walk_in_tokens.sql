-- Immediate ops cleanup: supersede stale active walk_in_tokens that poison
-- webcart phone-based session resolution (e.g. leftover takeaway T-2607-132
-- while the customer is on scheduled delivery).
--
-- Run in Supabase SQL editor. Adjust restaurant_id / phone as needed.

-- 1) Inspect active tokens for the affected customer
-- SELECT id, type, status, arrived_at, completed_at, meta
-- FROM walk_in_tokens
-- WHERE restaurant_id = '46fb9b9e-431a-43c9-9edb-d316b0fef216'
--   AND phone IN ('917305362067', '7305362067')
--   AND completed_at IS NULL
--   AND status IN ('waiting', 'pending_approval', 'seated', 'takeaway')
-- ORDER BY arrived_at DESC;

-- 2) Supersede unpaid / non-scheduled leftovers that are still active today
UPDATE walk_in_tokens
SET
  status = 'completed',
  completed_at = NOW(),
  meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(
    'superseded_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'supersede_reason', 'ops_stale_phone_fallback_cleanup_20260715'
  )
WHERE restaurant_id = '46fb9b9e-431a-43c9-9edb-d316b0fef216'
  AND phone IN ('917305362067', '7305362067')
  AND completed_at IS NULL
  AND status IN ('waiting', 'pending_approval', 'seated', 'takeaway')
  AND type IN ('takeaway', 'dinein', 'large_party')
  -- Keep scheduled_* pending_approval rows if you still need to act on them;
  -- unpaid scheduled leftovers can be included by removing the type filter.
  AND (
    meta->>'booking_id' IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.id = CAST(meta->>'booking_id' AS uuid)
        AND (b.payment_status = 'paid' OR b.status = 'confirmed')
    )
  );

-- 3) Clear broken menu_tokens → walk_in links for this phone so the next
--    WhatsApp menu send creates a fresh scheduled_delivery binding.
UPDATE menu_tokens
SET
  is_active = FALSE,
  updated_at = NOW()
WHERE restaurant_id = '46fb9b9e-431a-43c9-9edb-d316b0fef216'
  AND phone IN ('917305362067', '7305362067', '91917305362067')
  AND is_active = TRUE;
