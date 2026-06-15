-- Cloud kitchen / delivery-only configuration.
-- Run once in Supabase SQL editor.

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS restaurant_type text NOT NULL DEFAULT 'restaurant'
    CHECK (restaurant_type IN ('restaurant', 'cloud_kitchen'));

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS pickup_address text,
  ADD COLUMN IF NOT EXISTS pickup_latitude numeric(10,7),
  ADD COLUMN IF NOT EXISTS pickup_longitude numeric(10,7);

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS delivery_charge_default numeric(8,2) NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS delivery_charge_tiers jsonb NOT NULL DEFAULT
    '[{"max_km": 3, "charge": 20}, {"max_km": 6, "charge": 30}, {"max_km": null, "charge": 40}]'::jsonb;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS min_delivery_order_amount numeric(8,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS min_takeaway_order_amount numeric(8,2) NOT NULL DEFAULT 0;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS scheduled_delivery_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN restaurants.restaurant_type IS
  'restaurant = dine-in venue; cloud_kitchen = delivery/takeaway hub with pickup address on confirmations';

COMMENT ON COLUMN restaurants.pickup_address IS
  'Human-readable pickup location shown on takeaway confirmations (cloud kitchens)';

COMMENT ON COLUMN restaurants.delivery_charge_tiers IS
  'Distance tiers: [{"max_km": 3, "charge": 20}, {"max_km": null, "charge": 40}] — null max_km = beyond previous tiers';

COMMENT ON COLUMN restaurants.min_delivery_order_amount IS
  'Minimum items subtotal (pre-charges) required for delivery orders, e.g. 150';
