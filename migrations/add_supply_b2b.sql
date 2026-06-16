-- Munafe Supply (B2B) — Phase 1 & 2 foundation
-- Run once in Supabase SQL editor.

CREATE TABLE IF NOT EXISTS supply_suppliers (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  slug                      text NOT NULL UNIQUE,
  phone                     text NOT NULL,
  gstin                     text,
  ordering_open_time        time NOT NULL DEFAULT '18:00',
  ordering_cutoff           time NOT NULL DEFAULT '22:00',
  ordering_always_open      boolean NOT NULL DEFAULT false,
  whatsapp_phone_number_id  text,
  whatsapp_access_token     text,
  owner_user_id             uuid,
  is_active                 boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supply_clients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id         uuid NOT NULL REFERENCES supply_suppliers(id) ON DELETE CASCADE,
  name                text NOT NULL,
  slug                text NOT NULL,
  phone               text NOT NULL,
  gstin               text,
  credit_limit        numeric(12,2) NOT NULL DEFAULT 0,
  credit_terms_days   int NOT NULL DEFAULT 30,
  credit_auto_block   boolean NOT NULL DEFAULT true,
  delivery_days       text[] NOT NULL DEFAULT ARRAY['Monday','Wednesday','Friday'],
  address             text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, phone),
  UNIQUE (supplier_id, slug)
);

CREATE TABLE IF NOT EXISTS supply_catalog_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id     uuid NOT NULL REFERENCES supply_suppliers(id) ON DELETE CASCADE,
  name            text NOT NULL,
  category        text,
  unit            text NOT NULL DEFAULT 'kg',
  default_price   numeric(12,2) NOT NULL DEFAULT 0,
  hsn_code        text,
  gst_rate        numeric(5,2) NOT NULL DEFAULT 0,
  is_available    boolean NOT NULL DEFAULT true,
  min_order_qty   numeric(10,3) NOT NULL DEFAULT 0,
  display_order   int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supply_client_prices (
  client_id   uuid NOT NULL REFERENCES supply_clients(id) ON DELETE CASCADE,
  item_id     uuid NOT NULL REFERENCES supply_catalog_items(id) ON DELETE CASCADE,
  price       numeric(12,2) NOT NULL,
  PRIMARY KEY (client_id, item_id)
);

CREATE TABLE IF NOT EXISTS supply_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id     uuid NOT NULL REFERENCES supply_suppliers(id) ON DELETE CASCADE,
  client_id       uuid NOT NULL REFERENCES supply_clients(id) ON DELETE CASCADE,
  order_number    text NOT NULL,
  delivery_date   date,
  status          text NOT NULL DEFAULT 'confirmed',
  total_amount    numeric(12,2) NOT NULL DEFAULT 0,
  gst_amount      numeric(12,2) NOT NULL DEFAULT 0,
  special_notes   text,
  source          text NOT NULL DEFAULT 'form',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, order_number)
);

CREATE TABLE IF NOT EXISTS supply_order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES supply_orders(id) ON DELETE CASCADE,
  item_id      uuid NOT NULL REFERENCES supply_catalog_items(id),
  qty          numeric(10,3) NOT NULL,
  unit         text NOT NULL,
  unit_price   numeric(12,2) NOT NULL,
  line_total   numeric(12,2) NOT NULL,
  gst_rate     numeric(5,2) NOT NULL DEFAULT 0,
  gst_amount   numeric(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS supply_credit_ledger (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id       uuid NOT NULL REFERENCES supply_suppliers(id) ON DELETE CASCADE,
  client_id         uuid NOT NULL REFERENCES supply_clients(id) ON DELETE CASCADE,
  entry_date        date NOT NULL DEFAULT CURRENT_DATE,
  type              text NOT NULL CHECK (type IN ('debit', 'credit')),
  amount            numeric(12,2) NOT NULL,
  balance_after     numeric(12,2) NOT NULL,
  order_id          uuid REFERENCES supply_orders(id),
  payment_claim_id  uuid,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supply_payment_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id     uuid NOT NULL REFERENCES supply_suppliers(id) ON DELETE CASCADE,
  client_id       uuid NOT NULL REFERENCES supply_clients(id) ON DELETE CASCADE,
  claimed_amount  numeric(12,2),
  method          text,
  reference       text,
  raw_message     text,
  status          text NOT NULL DEFAULT 'pending',
  claimed_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

ALTER TABLE supply_credit_ledger
  ADD CONSTRAINT supply_credit_ledger_payment_claim_fkey
  FOREIGN KEY (payment_claim_id) REFERENCES supply_payment_claims(id);

CREATE TABLE IF NOT EXISTS supply_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES supply_orders(id) ON DELETE CASCADE,
  invoice_number  text NOT NULL,
  pdf_url         text,
  sent_at         timestamptz
);

CREATE TABLE IF NOT EXISTS supply_credit_alerts_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES supply_clients(id) ON DELETE CASCADE,
  alert_type      text NOT NULL,
  threshold_pct   int,
  fired_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supply_clients_phone ON supply_clients (phone);
CREATE INDEX IF NOT EXISTS idx_supply_clients_supplier ON supply_clients (supplier_id);
CREATE INDEX IF NOT EXISTS idx_supply_orders_client ON supply_orders (client_id, status);
CREATE INDEX IF NOT EXISTS idx_supply_ledger_client ON supply_credit_ledger (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supply_suppliers_wa ON supply_suppliers (whatsapp_phone_number_id);

COMMENT ON TABLE supply_suppliers IS 'Munafe Supply — food supplier tenant (B2B WhatsApp + dashboard)';
COMMENT ON COLUMN supply_suppliers.ordering_always_open IS 'Skip daily 6 PM–cutoff ordering window when true';
