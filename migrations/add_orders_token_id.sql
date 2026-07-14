-- Link POS orders to portal walk-in tokens.
-- walk_in_tokens.id is text (e.g. T-2607-001), not uuid.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS token_id text REFERENCES walk_in_tokens(id);

CREATE INDEX IF NOT EXISTS idx_orders_token_id ON orders(token_id);
