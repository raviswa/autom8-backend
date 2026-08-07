-- Restaurant-level flag: catalog prices already include GST (do not add GST on top at checkout).
-- When true, GST is back-calculated for invoice disclosure only; total charged = pre-tax display total.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS gst_inclusive boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.gst_inclusive IS
  'When true, menu/catalog prices already include GST. Checkout does not add GST again; gst_amount is back-calculated for receipts.';
