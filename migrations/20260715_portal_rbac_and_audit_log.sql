-- Portal-scoped RBAC + owner audit log (additive only).
-- Does not alter employees.role or existing auth behaviour.
-- portal_rbac_enforced defaults false — no outlet is cut over by this migration.

BEGIN;

-- ── 1. employee_portal_access ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.employee_portal_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  lob_type text NULL,
  portal text NOT NULL,
  access_level text NOT NULL,
  granted_by uuid NULL REFERENCES public.employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Postgres UNIQUE treats NULLs as distinct; COALESCE so one LOB-agnostic
-- grant per (employee, outlet, portal) is enforced.
CREATE UNIQUE INDEX IF NOT EXISTS idx_epa_unique_grant
  ON public.employee_portal_access (
    employee_id,
    restaurant_id,
    portal,
    (COALESCE(lob_type, ''))
  );

CREATE INDEX IF NOT EXISTS idx_epa_lookup
  ON public.employee_portal_access (employee_id, restaurant_id, portal);

-- ── 2. audit_log ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  lob_type text NULL,
  portal text NOT NULL,
  action text NOT NULL,
  entity_type text NULL,
  entity_id text NULL,
  actor_employee_id uuid NULL REFERENCES public.employees(id),
  actor_role text NULL,
  before jsonb NULL,
  after jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_restaurant_time
  ON public.audit_log (restaurant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON public.audit_log (actor_employee_id, created_at DESC);

-- ── 3. Outlet rollout flag ───────────────────────────────────────────────────
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS portal_rbac_enforced boolean NOT NULL DEFAULT false;

COMMENT ON TABLE public.employee_portal_access IS
  'Fine-grained portal grants. Zero rows for an employee => legacy employees.role behavior.';
COMMENT ON TABLE public.audit_log IS
  'Owner-visible activity log. Writes must never block request handlers.';
COMMENT ON COLUMN public.tenants.portal_rbac_enforced IS
  'Owner opted into portal RBAC UI/config. Must not alone change middleware enforcement vs legacy fallback.';

COMMIT;
