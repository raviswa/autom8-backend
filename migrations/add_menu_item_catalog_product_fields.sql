-- Packaged food / retail product-detail columns + multi-image gallery URLs.
-- Safe to run multiple times (IF NOT EXISTS).

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS pack_size_label text;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS weight_grams integer;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS shelf_life_days integer;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS allergens text;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS condition text;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS original_mrp numeric;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS warranty_days integer;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS colour text;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS image_url_2 text;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS image_url_3 text;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS image_url_4 text;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS image_url_5 text;
