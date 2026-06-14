-- feedback_pending may have set_updated_at() trigger without an updated_at column.
ALTER TABLE feedback_pending
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE feedback_pending
SET updated_at = COALESCE(feedback_sent_at, freed_at, NOW())
WHERE updated_at IS NULL;

-- Dedup existing open rows (keep oldest freed_at per customer) before adding constraint.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY restaurant_id, customer_phone
      ORDER BY freed_at ASC, id ASC
    ) AS rn
  FROM feedback_pending
  WHERE feedback_sent = false
)
UPDATE feedback_pending
SET
  feedback_sent    = true,
  feedback_sent_at = COALESCE(feedback_sent_at, NOW()),
  updated_at       = NOW()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Prevent multiple open feedback_pending rows per customer per restaurant.
CREATE UNIQUE INDEX IF NOT EXISTS feedback_pending_one_open_per_customer
  ON feedback_pending (restaurant_id, customer_phone)
  WHERE feedback_sent = false;
