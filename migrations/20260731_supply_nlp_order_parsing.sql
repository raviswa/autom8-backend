-- Munafe Supply — free-text WhatsApp NLP order parsing (B2B pilot)
-- Feature flag defaults OFF. Enable per supplier after validating parse logs.

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS nlp_order_parsing_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.suppliers.nlp_order_parsing_enabled IS
  'When true, WhatsApp free-text order parsing + confirmation is enabled for this supplier. Pilot rollout only.';

CREATE TABLE IF NOT EXISTS public.supply_nlp_order_parse_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id     uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  client_id       uuid REFERENCES public.supply_clients(id) ON DELETE SET NULL,
  phone           text,
  draft_id        text,
  raw_text        text NOT NULL,
  parsed_output   jsonb NOT NULL DEFAULT '{}'::jsonb,
  unmatched       jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence_avg  numeric(4,3),
  outcome         text NOT NULL DEFAULT 'parsed'
                  CHECK (outcome = ANY (ARRAY[
                    'parsed',
                    'partial',
                    'no_match',
                    'confirmed',
                    'edited',
                    'cancelled',
                    'confirm_failed'
                  ])),
  order_id        uuid REFERENCES public.supply_orders(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supply_nlp_order_parse_logs_supplier_created_idx
  ON public.supply_nlp_order_parse_logs (supplier_id, created_at DESC);

CREATE INDEX IF NOT EXISTS supply_nlp_order_parse_logs_draft_id_idx
  ON public.supply_nlp_order_parse_logs (draft_id)
  WHERE draft_id IS NOT NULL;

COMMENT ON TABLE public.supply_nlp_order_parse_logs IS
  'Eval log for Supply WhatsApp NLP order parsing: raw → parsed → client outcome.';
