-- Delivery distance: radius cap, road-distance support metadata on bookings (optional).
-- Run once in Supabase SQL editor after add_cloud_kitchen_config.sql.

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS max_delivery_radius_km numeric(6,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN restaurants.max_delivery_radius_km IS
  'Max road/straight-line delivery distance in km. 0 = no cap. Orders beyond this are rejected when distance is known.';
