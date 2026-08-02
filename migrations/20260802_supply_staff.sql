-- Migration: supply_staff — multi-user login support for the supplier portal
--
-- Backward compatible: existing suppliers.auth_user_id logins keep working
-- unchanged (getSupplierContext falls back to that path when no supply_staff
-- row exists). No data migration required for existing single-login
-- suppliers unless you want to formally register the owner as a
-- supply_staff row too (optional, see backfill below).
--
-- Note: email is UNIQUE globally (one person, one supplier staff seat).
-- Deactivated rows still hold the email — re-invite must reactivate/update.

CREATE TABLE IF NOT EXISTS public.supply_staff (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL,
  auth_user_id uuid UNIQUE,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text,
  role text NOT NULL CHECK (role = ANY (ARRAY['owner'::text, 'manager'::text, 'warehouse'::text, 'delivery'::text, 'accounts'::text])),
  is_active boolean DEFAULT true,
  last_login timestamp without time zone,
  hired_at timestamp with time zone DEFAULT now(),
  terminated_at timestamp with time zone,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  CONSTRAINT supply_staff_pkey PRIMARY KEY (id),
  CONSTRAINT supply_staff_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id)
);

CREATE INDEX IF NOT EXISTS idx_supply_staff_supplier_id ON public.supply_staff(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supply_staff_auth_user_id ON public.supply_staff(auth_user_id);

-- Optional backfill: formally register each existing supplier's own login
-- as an 'owner' row in supply_staff, so the roster (GET /api/supply/staff)
-- shows them too instead of being empty until the first invite. Safe to
-- run after login + middleware understand supply_staff.
--
-- INSERT INTO public.supply_staff (supplier_id, auth_user_id, name, email, phone, role)
-- SELECT id, auth_user_id, name, email, phone, 'owner'
-- FROM public.suppliers
-- WHERE auth_user_id IS NOT NULL
--   AND NOT EXISTS (
--     SELECT 1 FROM public.supply_staff WHERE supply_staff.auth_user_id = suppliers.auth_user_id
--   );
