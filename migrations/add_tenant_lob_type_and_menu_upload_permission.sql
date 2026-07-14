-- Per-tenant business type + owner-governed manager menu-upload permission.
-- Backward-compatible: defaults keep all existing tenants on restaurant behaviour.

BEGIN;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS lob_type text NOT NULL DEFAULT 'restaurant',
  ADD COLUMN IF NOT EXISTS allow_manager_menu_upload boolean NOT NULL DEFAULT false;

-- Backfill any rows that slipped through before the NOT NULL default was applied.
UPDATE public.tenants
SET lob_type = 'restaurant'
WHERE lob_type IS NULL OR btrim(lob_type) = '';

UPDATE public.tenants
SET allow_manager_menu_upload = false
WHERE allow_manager_menu_upload IS NULL;

COMMIT;
