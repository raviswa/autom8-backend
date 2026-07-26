-- Safe to run multiple times.
-- Append-only history of finished-goods batches received into sellable stock.

CREATE TABLE IF NOT EXISTS stock_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  qty_added INTEGER NOT NULL CHECK (qty_added > 0),
  made_on_date DATE,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_batches_restaurant_item_created
  ON stock_batches (restaurant_id, menu_item_id, created_at DESC);

COMMENT ON TABLE stock_batches IS
  'Append-only history of stock added for packaged-goods items; sellable balance remains menu_items.current_stock.';

COMMENT ON COLUMN stock_batches.qty_added IS
  'Units received in this batch. Existing remaining stock is not replaced.';
