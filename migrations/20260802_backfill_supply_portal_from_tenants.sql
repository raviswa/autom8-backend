-- Link Autom8 supply/B2B tenant owners to a suppliers portal login.
-- Fixes: supply login "Supplier account not set up. No profile found"
-- when the user only exists as employees + tenants (lob_type supply/b2b).
--
-- Safe to re-run: skips emails that already have a suppliers or supply_staff row.

-- 1) Create suppliers for owners of supply/b2b tenants who have no supplier yet
INSERT INTO public.suppliers (
  auth_user_id,
  name,
  business_name,
  email,
  phone,
  city,
  address,
  lob_type,
  waba_phone,
  is_active
)
SELECT
  e.id AS auth_user_id,
  COALESCE(NULLIF(trim(e.full_name), ''), split_part(e.email, '@', 1)) AS name,
  COALESCE(NULLIF(trim(t.display_name), ''), NULLIF(trim(t.name), ''), 'Supply business') AS business_name,
  lower(trim(e.email)) AS email,
  COALESCE(
    NULLIF(regexp_replace(COALESCE(e.phone, e.whatsapp_number, ''), '\D', '', 'g'), ''),
    '0000000000'
  ) AS phone,
  NULL AS city,
  NULL AS address,
  'food_service' AS lob_type,
  NULLIF(e.whatsapp_number, '') AS waba_phone,
  true AS is_active
FROM public.employees e
JOIN public.tenants t ON t.id = e.restaurant_id
WHERE e.is_active IS DISTINCT FROM false
  AND e.role = 'owner'
  AND e.email IS NOT NULL
  AND lower(trim(t.lob_type)) IN ('supply', 'b2b_supply', 'b2b')
  AND NOT EXISTS (
    SELECT 1 FROM public.suppliers s
    WHERE s.auth_user_id = e.id
       OR lower(s.email) = lower(trim(e.email))
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.supply_staff ss
    WHERE ss.auth_user_id = e.id
       OR lower(ss.email) = lower(trim(e.email))
  );

-- 2) Optional: register those new (and existing) supplier owners in supply_staff
INSERT INTO public.supply_staff (supplier_id, auth_user_id, name, email, phone, role)
SELECT
  s.id,
  s.auth_user_id,
  s.name,
  s.email,
  s.phone,
  'owner'
FROM public.suppliers s
WHERE s.auth_user_id IS NOT NULL
  AND s.is_active IS DISTINCT FROM false
  AND NOT EXISTS (
    SELECT 1 FROM public.supply_staff ss
    WHERE ss.auth_user_id = s.auth_user_id
  );

-- Spot-check for the FNB owner email (expect one suppliers + one supply_staff row):
-- SELECT id, business_name, email, auth_user_id FROM suppliers WHERE email = 'raviswa.aiml@gmail.com';
-- SELECT id, role, email, supplier_id FROM supply_staff WHERE email = 'raviswa.aiml@gmail.com';
