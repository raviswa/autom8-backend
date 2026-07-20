-- Packaging tare + batch inventory + stock waitlist for packaged-food LOBs.
-- Safe to run multiple times.

-- Extra grams added to every shipped parcel (box / ice pack / padding).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS packaging_weight_grams integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN tenants.packaging_weight_grams IS
  'Tare grams added to cart weight for courier / Shiprocket quotes';

-- NULL = unlimited (boolean is_stocked toggle only). Set to N for batch jars.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS current_stock integer;

COMMENT ON COLUMN menu_items.current_stock IS
  'Batch quantity on hand. NULL = do not track qty (manual stock toggle). 0 = sold out.';

CREATE TABLE IF NOT EXISTS stock_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  retailer_id text,
  item_name text,
  customer_phone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  UNIQUE (restaurant_id, customer_phone, retailer_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_waitlist_restaurant_item
  ON stock_waitlist (restaurant_id, retailer_id)
  WHERE notified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_stock_waitlist_menu_item
  ON stock_waitlist (menu_item_id)
  WHERE notified_at IS NULL AND menu_item_id IS NOT NULL;

COMMENT ON TABLE stock_waitlist IS
  'Customers waiting for a sold-out SKU; notified via WhatsApp when restocked';
