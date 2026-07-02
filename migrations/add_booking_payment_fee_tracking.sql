ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS payment_method varchar(20),
  ADD COLUMN IF NOT EXISTS munafe_fee_pct numeric(6,4),
  ADD COLUMN IF NOT EXISTS munafe_fee_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS order_subtotal numeric(12,2),
  ADD COLUMN IF NOT EXISTS restaurant_payout numeric(12,2);
