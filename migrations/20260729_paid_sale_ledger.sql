-- Durable paid-sale ledger: item-level spend + GST per successful payment.
-- Invoices remain ephemeral (~3d receipt/Zoho); this table is owner-dashboard SoT.
-- Apply in Supabase SQL editor (or migration runner) before deploying the backend
-- that reads/writes these tables.

CREATE TABLE IF NOT EXISTS paid_sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lob_type TEXT,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  order_id UUID,
  customer_phone TEXT,
  customer_name TEXT,
  service_type TEXT,
  token_number TEXT,
  subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
  gst_rate NUMERIC(6, 2) NOT NULL DEFAULT 5,
  cgst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  sgst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  igst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  gst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  delivery_charge NUMERIC(12, 2) NOT NULL DEFAULT 0,
  grand_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paid_sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paid_sale_id UUID NOT NULL REFERENCES paid_sales(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  menu_item_id UUID,
  item_name TEXT NOT NULL,
  item_sku TEXT,
  quantity NUMERIC(12, 3) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  line_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent writes: one ledger row per paid booking / POS order.
CREATE UNIQUE INDEX IF NOT EXISTS uix_paid_sales_booking
  ON paid_sales (booking_id)
  WHERE booking_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uix_paid_sales_order
  ON paid_sales (order_id)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_paid_sales_restaurant_paid_at
  ON paid_sales (restaurant_id, paid_at DESC);

CREATE INDEX IF NOT EXISTS idx_paid_sale_items_restaurant_paid_at
  ON paid_sale_items (restaurant_id, paid_at DESC);

CREATE INDEX IF NOT EXISTS idx_paid_sale_items_sale
  ON paid_sale_items (paid_sale_id);

COMMENT ON TABLE paid_sales IS
  'Durable order-level paid collection with GST breakdown. Written on payment success for all LOBs.';

COMMENT ON TABLE paid_sale_items IS
  'Durable item-level spend lines for paid_sales. Source for top-menu and customer-spend analytics.';
