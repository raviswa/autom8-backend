-- add_menu_tokens.sql
-- Deterministic web-menu link tokens for chat booking entry points.

CREATE TABLE IF NOT EXISTS public.menu_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  phone text NOT NULL,
  session_token text NOT NULL,
  walk_in_token_id text NULL REFERENCES public.walk_in_tokens(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, phone),
  UNIQUE (session_token)
);

CREATE INDEX IF NOT EXISTS idx_menu_tokens_lookup
  ON public.menu_tokens (session_token, restaurant_id, is_active, expires_at);

CREATE INDEX IF NOT EXISTS idx_menu_tokens_restaurant_phone
  ON public.menu_tokens (restaurant_id, phone, is_active, expires_at);

CREATE OR REPLACE FUNCTION public.touch_menu_tokens_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_menu_tokens_updated_at ON public.menu_tokens;
CREATE TRIGGER trg_touch_menu_tokens_updated_at
BEFORE UPDATE ON public.menu_tokens
FOR EACH ROW
EXECUTE FUNCTION public.touch_menu_tokens_updated_at();
