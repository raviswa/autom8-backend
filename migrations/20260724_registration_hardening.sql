-- Registration hardening: failure log, drafts, idempotency + unique active phone
-- (with one test exemption).
--
-- Unique index applies to all active phone_number_id values EXCEPT
-- 1086618881209069 — shared across test restaurants 30ee8983-... and 46fb9b9e-...
-- At go-live: dedupe that MID, then recreate the index WITHOUT the exemption.

-- FR-4: support triage for partial registration failures
CREATE TABLE IF NOT EXISTS public.registration_failures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text,
  slug          text,
  restaurant_id uuid,
  auth_user_id  uuid,
  failed_step   text,
  error_message text,
  meta          jsonb DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registration_failures_email_idx
  ON public.registration_failures (email);

CREATE INDEX IF NOT EXISTS registration_failures_created_at_idx
  ON public.registration_failures (created_at DESC);

-- FR-6: server-side WhatsApp checkpoint / draft
CREATE TABLE IF NOT EXISTS public.registration_drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  draft           jsonb NOT NULL DEFAULT '{}'::jsonb,
  waba_id         text,
  phone_number_id text,
  whatsapp_number text,
  embedded_signup_code text,
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS registration_drafts_email_uidx
  ON public.registration_drafts (lower(email));

-- FR-8: idempotent register retries
CREATE TABLE IF NOT EXISTS public.registration_idempotency_keys (
  idempotency_key text PRIMARY KEY,
  email           text,
  response        jsonb NOT NULL,
  status_code     int NOT NULL DEFAULT 201,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registration_idempotency_created_at_idx
  ON public.registration_idempotency_keys (created_at DESC);

-- FR-3: unique active phone_number_id, exempt shared test MID
-- (Safe even when 1086618881209069 has 2+ active rows.)
CREATE UNIQUE INDEX IF NOT EXISTS tenant_integrations_phone_number_id_active_uidx
  ON public.tenant_integrations (phone_number_id)
  WHERE is_active = true
    AND phone_number_id IS NOT NULL
    AND length(trim(phone_number_id)) > 0
    AND phone_number_id <> '1086618881209069';

-- =============================================================================
-- GO-LIVE: remove the test exemption
-- =============================================================================
-- 1) Decide which restaurant keeps 1086618881209069; deactivate the other(s)
-- 2) DROP INDEX IF EXISTS public.tenant_integrations_phone_number_id_active_uidx;
-- 3) CREATE UNIQUE INDEX ... without the `<> '1086618881209069'` predicate
--    (full unique active phone_number_id — see commented block in git history)
