-- Gift orders previously had no way to record a shipping address distinct
-- from the buyer/gifter — the physical order could only ship to whatever the
-- buyer typed as "their" delivery address. This adds an explicit recipient
-- shipping address so gift orders can be traced back to where they actually
-- shipped, separate from the gifter's own identity (name/phone/payment).

ALTER TABLE gift_links
  ADD COLUMN IF NOT EXISTS recipient_address text,
  ADD COLUMN IF NOT EXISTS recipient_pincode text;

COMMENT ON COLUMN gift_links.recipient_address IS 'Shipping address the gift order was actually delivered to (may differ from the gifter''s own address).';
COMMENT ON COLUMN gift_links.recipient_pincode IS 'Delivery pincode used to compute shipping for the gift order.';
