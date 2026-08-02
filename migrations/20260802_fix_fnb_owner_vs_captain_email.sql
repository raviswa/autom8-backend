-- Fix: raviswa.aiml@gmail.com was onboarded as captain on a demo restaurant,
-- conflicting with FNB Supply Lab owner login (same Auth email = one employees row).
-- Goal: remove captain assignment; retain owner login for FNB Supply Lab.
--
-- Tenant: FNB Supply Lab / Munafe Supply
-- id = 5d272b64-04b0-4f5b-8f6a-2f1a0593b0b6
--
-- Run in Supabase SQL editor. Review the SELECT output before the UPDATE.

-- 1) Inspect current binding(s)
SELECT
  e.id,
  e.email,
  e.role,
  e.restaurant_id,
  e.is_active,
  e.full_name,
  t.name AS tenant_name,
  t.display_name,
  t.lob_type,
  t.short_code
FROM public.employees e
LEFT JOIN public.tenants t ON t.id = e.restaurant_id
WHERE lower(e.email) = lower('raviswa.aiml@gmail.com');

-- 2) Reassign that Auth user → FNB Supply Lab owner (drops captain role)
UPDATE public.employees e
SET
  role = 'owner',
  restaurant_id = '5d272b64-04b0-4f5b-8f6a-2f1a0593b0b6'::uuid,
  brand_id = NULL,
  is_active = true,
  updated_at = now()
WHERE lower(e.email) = lower('raviswa.aiml@gmail.com')
  AND (
    e.role = 'captain'
    OR e.restaurant_id IS DISTINCT FROM '5d272b64-04b0-4f5b-8f6a-2f1a0593b0b6'::uuid
  );

-- 3) Confirm
SELECT
  e.id,
  e.email,
  e.role,
  e.restaurant_id,
  e.is_active,
  t.name AS tenant_name,
  t.display_name,
  t.lob_type
FROM public.employees e
JOIN public.tenants t ON t.id = e.restaurant_id
WHERE lower(e.email) = lower('raviswa.aiml@gmail.com');

-- Expected after UPDATE:
--   role = owner
--   restaurant_id = 5d272b64-04b0-4f5b-8f6a-2f1a0593b0b6
--   tenant = FNB Supply Lab / Munafe Supply
--
-- Login: same email + existing password → owner dashboard for FNB Supply Lab.
-- Demo restaurant will no longer have this email as captain; onboard a different
-- captain email there if you still need that role.
