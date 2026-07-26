-- Hot-path indexes for WhatsApp inbound latency.
-- Safe to run multiple times.
--
-- These match lookups the bot hits every message (session, ready-order,
-- active walk-in, open feedback invite). PKs/FKs alone do not cover them.

-- conversation_states: session get/upsert on every turn.
-- Deduplicate before unique index (keep newest row per restaurant+phone).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY restaurant_id, customer_phone
      ORDER BY updated_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM conversation_states
)
DELETE FROM conversation_states AS cs
USING ranked
WHERE cs.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_states_restaurant_phone
  ON conversation_states (restaurant_id, customer_phone);

CREATE INDEX IF NOT EXISTS idx_conversation_states_restaurant_updated
  ON conversation_states (restaurant_id, updated_at DESC);

-- orders: ready-takeaway / customer history by phone
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_phone_status_created
  ON orders (restaurant_id, customer_phone, status, created_at DESC);

-- walk_in_tokens: active token recovery by phone
CREATE INDEX IF NOT EXISTS idx_walk_in_tokens_restaurant_phone_status_arrived
  ON walk_in_tokens (restaurant_id, phone, status, arrived_at DESC);

-- feedback_pending: open invite check before Node feedback-bridge hop
CREATE INDEX IF NOT EXISTS idx_feedback_pending_open_invite
  ON feedback_pending (restaurant_id, customer_phone, freed_at DESC)
  WHERE feedback_sent = TRUE AND manager_notified = FALSE;

-- menu_items: available catalog reads (bot/catalog send)
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant_available
  ON menu_items (restaurant_id, is_available)
  WHERE archived_at IS NULL;

-- tenants: resolve by WhatsApp display number (shared-WABA fallback)
CREATE INDEX IF NOT EXISTS idx_tenants_whatsapp_active_sort
  ON tenants (whatsapp_number, is_default_for_number DESC, sort_order ASC NULLS FIRST)
  WHERE is_active = TRUE AND whatsapp_number IS NOT NULL;

COMMENT ON INDEX uq_conversation_states_restaurant_phone IS
  'Session upsert conflict target + sub-10ms get_session_state lookups.';

COMMENT ON INDEX idx_feedback_pending_open_invite IS
  'Cheap existence check so Python can skip the 12s Node feedback-bridge HTTP hop.';
