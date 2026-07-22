-- Opt-in POS ↔ Supply inventory bridge.
-- Maps restaurant menu items to supply catalog SKUs; consumption is append-only
-- (does not mutate supply stock qty).

CREATE TABLE IF NOT EXISTS menu_item_supply_sku (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  supply_client_id UUID NOT NULL REFERENCES supply_clients(id) ON DELETE CASCADE,
  supply_sku_id UUID NOT NULL REFERENCES supply_catalog_items(id) ON DELETE CASCADE,
  consumption_ratio NUMERIC NOT NULL DEFAULT 1
    CHECK (consumption_ratio > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (restaurant_id, menu_item_id, supply_sku_id)
);

CREATE INDEX IF NOT EXISTS idx_menu_item_supply_sku_restaurant
  ON menu_item_supply_sku (restaurant_id);

CREATE INDEX IF NOT EXISTS idx_menu_item_supply_sku_client_sku
  ON menu_item_supply_sku (supply_client_id, supply_sku_id);

CREATE TABLE IF NOT EXISTS supply_consumption_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supply_client_id UUID NOT NULL REFERENCES supply_clients(id) ON DELETE CASCADE,
  supply_sku_id UUID NOT NULL REFERENCES supply_catalog_items(id) ON DELETE CASCADE,
  menu_item_id UUID REFERENCES menu_items(id) ON DELETE SET NULL,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  qty_consumed NUMERIC NOT NULL CHECK (qty_consumed > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent on fulfillment retries.
CREATE UNIQUE INDEX IF NOT EXISTS uix_supply_consumption_booking_sku_item
  ON supply_consumption_ledger (booking_id, supply_sku_id, menu_item_id)
  WHERE booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_supply_consumption_client_sku_created
  ON supply_consumption_ledger (supply_client_id, supply_sku_id, created_at DESC);

COMMENT ON TABLE menu_item_supply_sku IS
  'Opt-in map: restaurant menu item → supply catalog SKU with consumption ratio.';
COMMENT ON TABLE supply_consumption_ledger IS
  'Append-only estimated ingredient consumption from fulfilled POS orders.';
