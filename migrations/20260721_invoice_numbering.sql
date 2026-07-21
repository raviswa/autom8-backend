-- Sequential, gap-free-per-tenant invoice numbering.
-- GST law expects a continuous unique invoice series per financial year;
-- reusing the order_number (which may not be sequential/gap-free) as the
-- de-facto invoice identifier is a soft compliance risk. This adds a real
-- invoice_number column plus a per-tenant per-financial-year counter table.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS invoice_number text;

CREATE INDEX IF NOT EXISTS idx_invoices_restaurant_invoice_number
  ON invoices (restaurant_id, invoice_number);

CREATE TABLE IF NOT EXISTS invoice_counters (
  restaurant_id   uuid NOT NULL,
  financial_year  text NOT NULL,
  last_number     integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, financial_year)
);

COMMENT ON TABLE invoice_counters IS
  'Per-tenant, per-Indian-financial-year running counter used to mint sequential invoice_number values (e.g. INV/2026-27/000123).';
COMMENT ON COLUMN invoices.invoice_number IS
  'Sequential per-tenant invoice number, e.g. INV/2026-27/000123. Assigned once at first generation and never regenerated for the same order.';
