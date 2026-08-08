-- Allow Instagram publish-token step-up (purpose was added in app code without a CHECK update).
-- Without this, OTP insert fails with login_otp_codes_purpose_check and Settings shows
-- "Could not send verification code. Please try again later."

BEGIN;

ALTER TABLE public.login_otp_codes
  DROP CONSTRAINT IF EXISTS login_otp_codes_purpose_check;

ALTER TABLE public.login_otp_codes
  ADD CONSTRAINT login_otp_codes_purpose_check
  CHECK (purpose IN (
    'login',
    'password_reset',
    'delete_account',
    'whatsapp_bind',
    'instagram_bind',
    'change_owner_phone_old',
    'change_owner_phone_new',
    'change_owner_email',
    'change_manager_phone',
    'staff_terminate',
    'staff_elevate',
    'staff_password_reset'
  ));

ALTER TABLE public.auth_stepup_tokens
  DROP CONSTRAINT IF EXISTS auth_stepup_tokens_purpose_check;

ALTER TABLE public.auth_stepup_tokens
  ADD CONSTRAINT auth_stepup_tokens_purpose_check
  CHECK (purpose IN (
    'delete_account',
    'whatsapp_bind',
    'instagram_bind',
    'change_owner_phone_old',
    'change_owner_phone_new',
    'change_owner_email',
    'change_manager_phone',
    'staff_terminate',
    'staff_elevate',
    'staff_password_reset'
  ));

COMMIT;
