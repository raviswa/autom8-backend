-- Step-up WhatsApp OTP for sensitive actions (authenticated).
-- Extends login_otp_codes purposes and adds single-use step-up tokens.

BEGIN;

-- Widen purpose CHECK on login_otp_codes
ALTER TABLE public.login_otp_codes
  DROP CONSTRAINT IF EXISTS login_otp_codes_purpose_check;

ALTER TABLE public.login_otp_codes
  ADD CONSTRAINT login_otp_codes_purpose_check
  CHECK (purpose IN (
    'login',
    'password_reset',
    'delete_account',
    'whatsapp_bind',
    'change_owner_phone_old',
    'change_owner_phone_new',
    'change_owner_email',
    'change_manager_phone',
    'staff_terminate',
    'staff_elevate',
    'staff_password_reset'
  ));

CREATE TABLE IF NOT EXISTS public.auth_stepup_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  purpose      text NOT NULL,
  token_hash   text NOT NULL,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_stepup_tokens_purpose_check CHECK (purpose IN (
    'delete_account',
    'whatsapp_bind',
    'change_owner_phone_old',
    'change_owner_phone_new',
    'change_owner_email',
    'change_manager_phone',
    'staff_terminate',
    'staff_elevate',
    'staff_password_reset'
  ))
);

CREATE INDEX IF NOT EXISTS auth_stepup_tokens_user_purpose_idx
  ON public.auth_stepup_tokens (user_id, purpose, expires_at DESC);

CREATE INDEX IF NOT EXISTS auth_stepup_tokens_hash_idx
  ON public.auth_stepup_tokens (token_hash)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE public.auth_stepup_tokens IS
  'Single-use step-up proofs after WhatsApp OTP verify; purpose-bound.';

COMMIT;
