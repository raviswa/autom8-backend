-- Maker growth + finance flags / launch waitlist / gift links / recipes.
-- Safe to run multiple times.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS daily_settlement_enabled boolean;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS weekly_promo_drafts_enabled boolean DEFAULT true;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS instagram_handle text;

COMMENT ON COLUMN tenants.daily_settlement_enabled IS
  'NULL = default on for packaged LOBs; false disables evening WA settlement';
COMMENT ON COLUMN tenants.instagram_handle IS
  'Optional — never required for storefront or WhatsApp flows';

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS availability_status text;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS launch_at timestamptz;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS deposit_amount numeric;

COMMENT ON COLUMN menu_items.availability_status IS
  'in_stock | sold_out | coming_soon | preorder (NULL treated as in_stock)';

CREATE TABLE IF NOT EXISTS gift_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  booking_id uuid,
  gifter_phone text,
  recipient_phone text,
  recipient_name text,
  gift_message text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_gift_links_restaurant ON gift_links (restaurant_id);

CREATE TABLE IF NOT EXISTS sku_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  menu_item_id uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_name text NOT NULL,
  qty_per_unit numeric NOT NULL,
  unit text NOT NULL DEFAULT 'g',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sku_recipes_item ON sku_recipes (menu_item_id);

ALTER TABLE stock_waitlist ADD COLUMN IF NOT EXISTS reason text DEFAULT 'restock';
