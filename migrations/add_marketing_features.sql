-- Marketing dashboard: scheduled sends, drafts, automations, ROI attribution.
-- Run once in Supabase SQL editor.

ALTER TABLE broadcast_campaigns
  ADD COLUMN IF NOT EXISTS custom_message text,
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS recipient_phones jsonb,
  ADD COLUMN IF NOT EXISTS roi_orders_48h integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS roi_revenue_48h numeric(12,2) DEFAULT 0;

CREATE TABLE IF NOT EXISTS marketing_template_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'untitled_draft',
  payload jsonb NOT NULL DEFAULT '{}',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_template_drafts_restaurant
  ON marketing_template_drafts(restaurant_id);

CREATE TABLE IF NOT EXISTS marketing_automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger_type text NOT NULL,
  segment_type text NOT NULL,
  template_name text,
  custom_message text,
  is_active boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_automations_restaurant
  ON marketing_automations(restaurant_id);

COMMENT ON COLUMN broadcast_campaigns.recipient_phones IS
  'JSON array of {phone,name} sent to — used for 48h ROI attribution';
