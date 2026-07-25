-- WhatsApp OTP for password recovery / login (platform WABA).
-- Codes are stored hashed (HMAC-SHA256); never store raw OTP.

CREATE TABLE IF NOT EXISTS public.login_otp_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id),
  phone         text NOT NULL,
  code_hash     text NOT NULL,
  purpose       text NOT NULL CHECK (purpose IN ('login', 'password_reset')),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  attempt_count int NOT NULL DEFAULT 0,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_otp_tenant
  ON public.login_otp_codes (tenant_id, purpose);

CREATE INDEX IF NOT EXISTS idx_login_otp_rate
  ON public.login_otp_codes (tenant_id, purpose, created_at DESC);
