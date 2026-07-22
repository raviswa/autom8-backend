-- Track one-shot supply reorder nudges per client.
ALTER TABLE supply_clients
  ADD COLUMN IF NOT EXISTS last_reorder_nudge_at TIMESTAMPTZ;

COMMENT ON COLUMN supply_clients.last_reorder_nudge_at IS
  'When the last median-interval reorder WhatsApp nudge was sent; cleared conceptually by a new order (job skips until overdue again after next order).';
