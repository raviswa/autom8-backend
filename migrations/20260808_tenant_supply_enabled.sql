-- Supply add-on on primary packaged-catalog LOB (same WhatsApp / same tenant).
-- tenants.lob_type stays the primary LOB; supply_enabled marks the B2B add-on.
-- suppliers.restaurant_id links the suppliers row to that tenant (no second WABA).

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS supply_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenants.supply_enabled IS
  'True when this tenant also runs Autom8 Supply on the same WhatsApp. Implied true for lob_type b2b/supply/b2b_supply.';

UPDATE public.tenants
SET supply_enabled = true
WHERE lower(coalesce(lob_type, '')) IN ('b2b', 'supply', 'b2b_supply')
  AND supply_enabled IS DISTINCT FROM true;

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS restaurant_id uuid REFERENCES public.tenants(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.suppliers.restaurant_id IS
  'Autom8 tenant (primary LOB) that owns this supplier portal — same auth user / same WABA.';

CREATE UNIQUE INDEX IF NOT EXISTS suppliers_restaurant_id_uidx
  ON public.suppliers (restaurant_id)
  WHERE restaurant_id IS NOT NULL;

-- Best-effort backfill: owner employee on a b2b/supply tenant → matching suppliers row
UPDATE public.suppliers s
SET restaurant_id = e.restaurant_id
FROM public.employees e
JOIN public.tenants t ON t.id = e.restaurant_id
WHERE s.restaurant_id IS NULL
  AND e.role = 'owner'
  AND (
    s.auth_user_id = e.id
    OR (s.email IS NOT NULL AND lower(s.email) = lower(e.email))
  )
  AND lower(coalesce(t.lob_type, '')) IN ('b2b', 'supply', 'b2b_supply');
