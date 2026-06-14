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
  feedback_sent_at = NOW()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Prevent multiple open feedback_pending rows per customer per restaurant.
CREATE UNIQUE INDEX IF NOT EXISTS feedback_pending_one_open_per_customer
  ON feedback_pending (restaurant_id, customer_phone)
  WHERE feedback_sent = false;
