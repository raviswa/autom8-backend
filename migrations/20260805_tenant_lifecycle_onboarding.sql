-- Email-first onboarding: lifecycle_status + onboarding_step on tenants
-- Safe to run multiple times.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS lifecycle_status text;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS onboarding_step integer;

-- Existing tenants are live; new shells set onboarding at register time.
UPDATE public.tenants
SET lifecycle_status = 'active'
WHERE lifecycle_status IS NULL;

UPDATE public.tenants
SET onboarding_step = 5
WHERE onboarding_step IS NULL AND lifecycle_status = 'active';

ALTER TABLE public.tenants
  ALTER COLUMN lifecycle_status SET DEFAULT 'active';

ALTER TABLE public.tenants
  ALTER COLUMN onboarding_step SET DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_lifecycle_status_check'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_lifecycle_status_check
      CHECK (lifecycle_status IS NULL OR lifecycle_status IN ('onboarding', 'active'));
  END IF;
END $$;

COMMENT ON COLUMN public.tenants.lifecycle_status IS
  'onboarding = shell / wizard incomplete; active = wizard completed (or legacy tenant).';

COMMENT ON COLUMN public.tenants.onboarding_step IS
  'Wizard resume cursor: 0=start, 1=business done, 2=product, 3=delivery, 4=payment, 5=complete.';
