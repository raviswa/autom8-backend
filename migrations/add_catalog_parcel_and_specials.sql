-- Parcel/packaging charge per item (takeaway & door delivery) + special dish of the day.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS parcel_charge_per_item numeric(8,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN tenants.parcel_charge_per_item IS
  'Extra charge per cart item qty for takeaway/delivery (₹). Added before GST. 0 = disabled.';

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS is_special_today boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN menu_items.is_special_today IS
  'Manager-marked special for today. Shown as WA ordering suggestion only — not pushed to Meta catalog.';

CREATE INDEX IF NOT EXISTS idx_menu_items_special_today
  ON menu_items (restaurant_id)
  WHERE is_special_today = true;
