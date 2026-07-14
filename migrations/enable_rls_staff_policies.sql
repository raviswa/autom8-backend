-- ============================================================================
-- RLS policies for Autom8 staff (authenticated) + notes for backend services
-- ============================================================================
-- Run in Supabase SQL editor AFTER enabling RLS on tables.
--
-- IMPORTANT — backend API / chat:
--   Node (supabaseAdmin) and Python (AUTOM8_SUPABASE_SERVICE_KEY) use the
--   *service_role* key, which BYPASSES RLS automatically. Do NOT put the anon
--   key in SUPABASE_SERVICE_ROLE_KEY or AUTOM8_SUPABASE_SERVICE_KEY.
--
-- These policies are for:
--   • Owner dashboard direct Supabase reads (anon + user JWT)
--   • Realtime postgres_changes subscriptions
--   • Any future client-side Supabase usage
-- ============================================================================

-- Helper: outlet IDs this logged-in employee may access
CREATE OR REPLACE FUNCTION public.staff_restaurant_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.restaurant_id
  FROM employees e
  WHERE e.id = auth.uid()
    AND e.is_active = true
    AND e.restaurant_id IS NOT NULL
  UNION
  SELECT r.id
  FROM tenants r
  INNER JOIN employees e ON e.brand_id = r.brand_id
  WHERE e.id = auth.uid()
    AND e.is_active = true
    AND e.role IN ('brand_owner', 'brand_manager')
    AND r.is_active = true;
$$;

REVOKE ALL ON FUNCTION public.staff_restaurant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_restaurant_ids() TO authenticated;

-- ── walk_in_tokens ───────────────────────────────────────────────────────────
ALTER TABLE public.walk_in_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_walk_in_tokens_select ON public.walk_in_tokens;
CREATE POLICY staff_walk_in_tokens_select ON public.walk_in_tokens
  FOR SELECT TO authenticated
  USING (restaurant_id IN (SELECT public.staff_restaurant_ids()));

DROP POLICY IF EXISTS staff_walk_in_tokens_write ON public.walk_in_tokens;
CREATE POLICY staff_walk_in_tokens_write ON public.walk_in_tokens
  FOR ALL TO authenticated
  USING (restaurant_id IN (SELECT public.staff_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.staff_restaurant_ids()));

-- ── tables ───────────────────────────────────────────────────────────────────
ALTER TABLE public.tables ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_tables_all ON public.tables;
CREATE POLICY staff_tables_all ON public.tables
  FOR ALL TO authenticated
  USING (restaurant_id IN (SELECT public.staff_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.staff_restaurant_ids()));

-- ── orders ───────────────────────────────────────────────────────────────────
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_orders_all ON public.orders;
CREATE POLICY staff_orders_all ON public.orders
  FOR ALL TO authenticated
  USING (restaurant_id IN (SELECT public.staff_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.staff_restaurant_ids()));

-- ── order_items (via order) ────────────────────────────────────────────────────
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_order_items_all ON public.order_items;
CREATE POLICY staff_order_items_all ON public.order_items
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_items.order_id
        AND o.restaurant_id IN (SELECT public.staff_restaurant_ids())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_items.order_id
        AND o.restaurant_id IN (SELECT public.staff_restaurant_ids())
    )
  );

-- ── kds_items ────────────────────────────────────────────────────────────────
ALTER TABLE public.kds_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_kds_items_all ON public.kds_items;
CREATE POLICY staff_kds_items_all ON public.kds_items
  FOR ALL TO authenticated
  USING (restaurant_id IN (SELECT public.staff_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.staff_restaurant_ids()));

-- ── kot_tickets ──────────────────────────────────────────────────────────────
ALTER TABLE public.kot_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_kot_tickets_all ON public.kot_tickets;
CREATE POLICY staff_kot_tickets_all ON public.kot_tickets
  FOR ALL TO authenticated
  USING (restaurant_id IN (SELECT public.staff_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.staff_restaurant_ids()));

-- ── employees (read own profile) ─────────────────────────────────────────────
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_employees_self ON public.employees;
CREATE POLICY staff_employees_self ON public.employees
  FOR SELECT TO authenticated
  USING (id = auth.uid());

-- ── tenants (read assigned outlets) ──────────────────────────────────────
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_restaurants_select ON public.tenants;
CREATE POLICY staff_restaurants_select ON public.tenants
  FOR SELECT TO authenticated
  USING (id IN (SELECT public.staff_restaurant_ids()));

-- ── bookings (staff read/write for their outlet) ─────────────────────────────
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_bookings_all ON public.bookings;
CREATE POLICY staff_bookings_all ON public.bookings
  FOR ALL TO authenticated
  USING (restaurant_id IN (SELECT public.staff_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.staff_restaurant_ids()));

-- ── audit_logs ─────────────────────────────────────────────────────────────────
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_audit_logs_select ON public.audit_logs;
CREATE POLICY staff_audit_logs_select ON public.audit_logs
  FOR SELECT TO authenticated
  USING (restaurant_id IN (SELECT public.staff_restaurant_ids()));

DROP POLICY IF EXISTS staff_audit_logs_insert ON public.audit_logs;
CREATE POLICY staff_audit_logs_insert ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (restaurant_id IN (SELECT public.staff_restaurant_ids()));

-- ── menu_items ─────────────────────────────────────────────────────────────────
ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_menu_items_all ON public.menu_items;
CREATE POLICY staff_menu_items_all ON public.menu_items
  FOR ALL TO authenticated
  USING (restaurant_id IN (SELECT public.staff_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.staff_restaurant_ids()));
