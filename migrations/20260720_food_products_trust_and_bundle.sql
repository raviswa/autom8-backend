-- Food products trust / hamper catalog fields.
-- variant_group_id, size_label, item_type, meta already exist from earlier migrations.
-- Safe to run multiple times.

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS ingredients text;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS made_on_date date;

COMMENT ON COLUMN menu_items.ingredients IS
  'Ingredient list for packaged food (shown in webcart / WhatsApp description)';
COMMENT ON COLUMN menu_items.made_on_date IS
  'Latest production / made-on date for trust messaging (owner updates after a batch)';
