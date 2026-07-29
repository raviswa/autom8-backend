-- Persist WABA id on WhatsApp integrations (code has assumed this column for months).
-- Idempotent. Safe to re-run.

BEGIN;

ALTER TABLE tenant_integrations
  ADD COLUMN IF NOT EXISTS waba_id text;

COMMENT ON COLUMN public.tenant_integrations.waba_id IS
  'Meta WhatsApp Business Account id for this integration row (may mirror tenants.waba_id)';

CREATE INDEX IF NOT EXISTS tenant_integrations_waba_id_idx
  ON public.tenant_integrations (waba_id)
  WHERE waba_id IS NOT NULL;

-- Backfill from tenants when integration is active Meta WhatsApp and tenant has waba_id.
UPDATE public.tenant_integrations ti
SET waba_id = t.waba_id,
    updated_at = now()
FROM public.tenants t
WHERE ti.restaurant_id = t.id
  AND ti.provider = 'meta'
  AND ti.channel = 'whatsapp'
  AND ti.waba_id IS NULL
  AND t.waba_id IS NOT NULL
  AND trim(t.waba_id) <> '';

COMMIT;
