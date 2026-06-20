-- One non-terminal walk-in token per phone per restaurant (chat retry idempotency).
-- Run in Supabase SQL editor if not applied via deploy pipeline.

CREATE UNIQUE INDEX IF NOT EXISTS idx_walk_in_tokens_one_active_per_phone
  ON walk_in_tokens (restaurant_id, phone)
  WHERE status IN ('waiting', 'pending_approval', 'seated', 'takeaway')
    AND phone IS NOT NULL;

COMMENT ON INDEX idx_walk_in_tokens_one_active_per_phone IS
  'Prevents duplicate active tokens when customers retry Hi/dine-in during slow flows';
