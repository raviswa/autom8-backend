-- Scheduled takeaway (calendar / text pickup time).
-- Run once in Supabase SQL editor.

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS scheduled_takeaway_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN restaurants.scheduled_takeaway_enabled IS
  'When true, customers pick a pickup date/time via WhatsApp Flow calendar before ordering';
