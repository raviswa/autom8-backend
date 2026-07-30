-- Durable manager "force open" override for WhatsApp ordering.
-- When true, slot scheduler must not re-close the catalog.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS kitchen_force_open boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.kitchen_force_open IS
  'Manager/owner forced kitchen open; slot rotation must not deactivate stocked items until cleared.';
