-- PSL customization columns for ice cream flavours, pizza crust/toppings, add-ons.
-- Backward-compatible: all nullable or defaulted.
BEGIN;
ALTER TABLE public.menu_items
  ADD COLUMN IF NOT EXISTS flavour_group text NULL,
  ADD COLUMN IF NOT EXISTS scoop_count integer NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS crust_options text NULL,
  ADD COLUMN IF NOT EXISTS toppings_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS topping_extra_price numeric NULL;
COMMIT;
