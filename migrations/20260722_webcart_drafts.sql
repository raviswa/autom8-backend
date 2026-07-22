-- Abandoned webcart drafts for one-shot recovery nudges.
CREATE TABLE IF NOT EXISTS webcart_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  session_token TEXT,
  items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  item_count INTEGER NOT NULL DEFAULT 0,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reminder_sent_at TIMESTAMPTZ,
  converted_at TIMESTAMPTZ,
  UNIQUE (restaurant_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_webcart_drafts_abandon
  ON webcart_drafts (restaurant_id, updated_at)
  WHERE reminder_sent_at IS NULL AND converted_at IS NULL AND item_count > 0;

COMMENT ON TABLE webcart_drafts IS
  'Server-side cart snapshot for abandoned-cart WhatsApp recovery (one nudge max).';
