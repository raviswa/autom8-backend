'use strict';

/**
 * Resilient reads/writes for tenant_integrations WhatsApp / Instagram rows.
 * Older DBs may lack tenant_integrations.waba_id — never crash setup/status for that.
 */

const { supabaseAdmin } = require('../config/supabase');

const INTEGRATION_SELECT_FULL =
  'id, restaurant_id, phone_number_id, waba_id, access_token, webhook_secret, webhook_verify_token, config, is_active, updated_at';
const INTEGRATION_SELECT_CORE =
  'id, restaurant_id, phone_number_id, access_token, webhook_secret, webhook_verify_token, config, is_active, updated_at';
const INSTAGRAM_SELECT =
  'id, restaurant_id, access_token, config, is_active, updated_at';

function isMissingWabaIdColumn(error) {
  const msg = String(error?.message || '');
  return /waba_id/i.test(msg) && (/schema cache|column .* does not exist|Could not find/i.test(msg));
}

function stripWabaId(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const next = { ...payload };
  delete next.waba_id;
  return next;
}

/**
 * Active Meta WhatsApp integration for a restaurant.
 * Falls back to a select without waba_id when the column is absent.
 */
async function getActiveWhatsAppIntegration(restaurantId) {
  if (!restaurantId) return null;

  const full = await supabaseAdmin
    .from('tenant_integrations')
    .select(INTEGRATION_SELECT_FULL)
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'meta')
    .eq('channel', 'whatsapp')
    .eq('is_active', true)
    .maybeSingle();

  if (!full.error) return full.data || null;

  if (!isMissingWabaIdColumn(full.error)) {
    throw full.error;
  }

  console.warn('[tenantIntegrations] waba_id column missing — using core select. Run migrations/20260729_tenant_integrations_waba_id.sql');
  const core = await supabaseAdmin
    .from('tenant_integrations')
    .select(INTEGRATION_SELECT_CORE)
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'meta')
    .eq('channel', 'whatsapp')
    .eq('is_active', true)
    .maybeSingle();
  if (core.error) throw core.error;
  return core.data ? { ...core.data, waba_id: null } : null;
}

/** Latest Meta WhatsApp integration row (active or not). */
async function getLatestWhatsAppIntegration(restaurantId) {
  if (!restaurantId) return null;

  const full = await supabaseAdmin
    .from('tenant_integrations')
    .select(INTEGRATION_SELECT_FULL)
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'meta')
    .eq('channel', 'whatsapp')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!full.error) return full.data || null;
  if (!isMissingWabaIdColumn(full.error)) throw full.error;

  const core = await supabaseAdmin
    .from('tenant_integrations')
    .select(INTEGRATION_SELECT_CORE)
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'meta')
    .eq('channel', 'whatsapp')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (core.error) throw core.error;
  return core.data ? { ...core.data, waba_id: null } : null;
}

/**
 * Insert or update Meta WhatsApp integration.
 * Retries without waba_id if the column is not migrated yet.
 */
async function upsertWhatsAppIntegration(restaurantId, payload) {
  const base = {
    provider: 'meta',
    channel: 'whatsapp',
    ...payload,
    updated_at: payload.updated_at || new Date().toISOString(),
  };

  const existing = await getLatestWhatsAppIntegration(restaurantId);
  if (
    existing?.config
    && typeof existing.config === 'object'
    && base.config
    && typeof base.config === 'object'
  ) {
    base.config = { ...existing.config, ...base.config };
  }

  async function write(body) {
    if (existing?.id) {
      return supabaseAdmin
        .from('tenant_integrations')
        .update(body)
        .eq('id', existing.id)
        .select()
        .single();
    }
    return supabaseAdmin
      .from('tenant_integrations')
      .insert({ restaurant_id: restaurantId, ...body })
      .select()
      .single();
  }

  let { data, error } = await write(base);
  if (error && isMissingWabaIdColumn(error)) {
    console.warn('[tenantIntegrations] upsert without waba_id (column missing)');
    ({ data, error } = await write(stripWabaId(base)));
  }
  if (error) throw error;
  return data;
}

/** Latest Meta Instagram integration row (active or not). */
async function getLatestInstagramIntegration(restaurantId) {
  if (!restaurantId) return null;
  const { data, error } = await supabaseAdmin
    .from('tenant_integrations')
    .select(INSTAGRAM_SELECT)
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'meta')
    .eq('channel', 'instagram')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Insert or update Meta Instagram integration (Page token + IG Business Account).
 * Does not require phone_number_id / waba_id.
 */
async function upsertInstagramIntegration(restaurantId, payload) {
  if (!restaurantId) {
    const err = new Error('restaurantId is required');
    err.status = 400;
    throw err;
  }

  const base = {
    provider: 'meta',
    channel: 'instagram',
    is_active: true,
    ...payload,
    updated_at: payload.updated_at || new Date().toISOString(),
  };
  // Instagram channel must not inherit WhatsApp phone/waba keys by accident
  delete base.phone_number_id;
  delete base.waba_id;
  delete base.webhook_secret;
  delete base.webhook_verify_token;

  const existing = await getLatestInstagramIntegration(restaurantId);
  if (
    existing?.config
    && typeof existing.config === 'object'
    && base.config
    && typeof base.config === 'object'
  ) {
    base.config = { ...existing.config, ...base.config };
  }

  if (existing?.id) {
    const { data, error } = await supabaseAdmin
      .from('tenant_integrations')
      .update(base)
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabaseAdmin
    .from('tenant_integrations')
    .insert({ restaurant_id: restaurantId, ...base })
    .select()
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  isMissingWabaIdColumn,
  getActiveWhatsAppIntegration,
  getLatestWhatsAppIntegration,
  upsertWhatsAppIntegration,
  getLatestInstagramIntegration,
  upsertInstagramIntegration,
  INTEGRATION_SELECT_FULL,
  INTEGRATION_SELECT_CORE,
  INSTAGRAM_SELECT,
};
