-- Owner-configurable ready-time ranges + manager busy-kitchen toggle.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS takeaway_ready_range text,
  ADD COLUMN IF NOT EXISTS delivery_ready_range text,
  ADD COLUMN IF NOT EXISTS kitchen_busy boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.takeaway_ready_range IS
  'Optional display range for takeaway ETA, e.g. 20-30. Shown as "Usually …" — not a guarantee.';

COMMENT ON COLUMN tenants.delivery_ready_range IS
  'Optional display range for delivery ETA, e.g. 30-45. Shown as "Usually …" — not a guarantee.';

COMMENT ON COLUMN tenants.kitchen_busy IS
  'Manager toggle during rush. Appends high-volume delay note to takeaway/delivery confirmations.';
