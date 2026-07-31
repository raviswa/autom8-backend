-- Food products low-stock alerts (shared stock_alert_log for future restaurant use).

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS low_stock_alert_units integer DEFAULT 5;

COMMENT ON COLUMN menu_items.low_stock_alert_units IS
  'Alert managers when current_stock falls to this many units or below (food_products; blank/default 5).';

CREATE TABLE IF NOT EXISTS stock_alert_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  menu_item_id uuid NOT NULL REFERENCES menu_items(id),
  alert_level text NOT NULL,
  day date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (menu_item_id, alert_level, day)
);

CREATE INDEX IF NOT EXISTS idx_stock_alert_log_tenant_day
  ON stock_alert_log (tenant_id, day DESC);
