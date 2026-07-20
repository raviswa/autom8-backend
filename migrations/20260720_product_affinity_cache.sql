-- Cached product co-purchase affinity for webcart recommendations.
-- Refreshed on a schedule from order history (same signals as OwnerInsights combo patterns).
-- Safe to run multiple times.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS product_affinity jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN tenants.product_affinity IS
  'Cached item co-purchase graph: { updated_at, lookback_days, order_count, pairs, by_item }';
