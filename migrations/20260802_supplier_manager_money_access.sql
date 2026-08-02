-- Owner-configurable: allow managers to access Money section
-- (Payment Claims, Invoices, Statements, Ledger). Default false = accounts + owner only.

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS manager_money_access boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.suppliers.manager_money_access IS
  'When true, supply_staff with role=manager can access Money APIs and nav (claims, invoices, statements, ledger).';
