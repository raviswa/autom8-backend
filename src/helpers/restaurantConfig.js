// Per-restaurant config from Supabase (day-1 tenant model).
// Env vars are deprecated fallbacks for local dev only.

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { validateAndNormalizeWhatsApp } = require('./phoneFormat');

const OPERATIONAL_MANAGER_ROLES = ['manager', 'owner'];

const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map(); // restaurantId -> { data, expires_at }

async function _loadRow(restaurantId) {
  if (!restaurantId) return null;

  const cached = _cache.get(restaurantId);
  if (cached && Date.now() < cached.expires_at) return cached.data;

  const { data, error } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, manager_phone, whatsapp_number, waba_id, meta_catalog_id')
    .eq('id', restaurantId)
    .maybeSingle();

  if (error) {
    console.warn(`[restaurantConfig] load failed for ${restaurantId}:`, error.message);
    return null;
  }

  _cache.set(restaurantId, { data, expires_at: Date.now() + CACHE_TTL_MS });
  return data;
}

function invalidateRestaurantConfigCache(restaurantId) {
  if (restaurantId) _cache.delete(restaurantId);
  else _cache.clear();
}

/** Manager alert number — restaurants.manager_phone is canonical (primary on-call). */
async function getManagerPhone(restaurantId) {
  const row = await _loadRow(restaurantId);
  if (row?.manager_phone) return row.manager_phone;

  if (process.env.MANAGER_WHATSAPP_NUMBER) {
    console.warn(`[restaurantConfig] manager_phone missing for ${restaurantId} — using env fallback`);
    return process.env.MANAGER_WHATSAPP_NUMBER;
  }
  return null;
}

/**
 * All numbers that receive outbound operational manager alerts:
 * manager_phone + active manager/owner employees with WhatsApp (deduped).
 */
async function getOperationalAlertPhones(restaurantId) {
  const seen = new Set();
  const out = [];

  const add = (raw) => {
    const { value } = validateAndNormalizeWhatsApp(raw);
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  const row = await _loadRow(restaurantId);
  if (row?.manager_phone) add(row.manager_phone);

  const { data: employees, error } = await supabaseAdmin
    .from('employees')
    .select('whatsapp_number, phone, role')
    .eq('restaurant_id', restaurantId)
    .eq('is_active', true)
    .in('role', OPERATIONAL_MANAGER_ROLES);

  if (error) {
    console.warn(`[restaurantConfig] manager employees load failed: ${error.message}`);
  } else {
    for (const emp of employees ?? []) add(emp.whatsapp_number || emp.phone);
  }

  if (!out.length && process.env.MANAGER_WHATSAPP_NUMBER) {
    add(process.env.MANAGER_WHATSAPP_NUMBER);
  }

  return out;
}

/** Meta Commerce catalog ID for this outlet. Never env-fallback when restaurantId is set. */
async function getMetaCatalogId(restaurantId) {
  if (restaurantId) {
    const row = await _loadRow(restaurantId);
    if (row?.meta_catalog_id) return row.meta_catalog_id;

    console.error(
      `[restaurantConfig] meta_catalog_id missing for ${restaurantId} — ` +
      'refusing env fallback (wrong catalog is a showstopper)',
    );
    return null;
  }

  if (process.env.META_CATALOG_ID) {
    console.warn('[restaurantConfig] using META_CATALOG_ID env (no restaurantId — dev only)');
    return process.env.META_CATALOG_ID;
  }
  return null;
}

/** WhatsApp Cloud API credentials for an outlet. */
async function getWhatsAppIntegration(restaurantId) {
  if (!restaurantId) return null;

  const { data, error } = await supabaseAdmin
    .from('restaurant_integrations')
    .select('access_token, phone_number_id, api_endpoint, provider')
    .eq('restaurant_id', restaurantId)
    .eq('channel', 'whatsapp')
    .eq('is_active', true)
    .eq('provider', 'meta')
    .maybeSingle();

  if (!error && data?.access_token && data?.phone_number_id) {
    return {
      accessToken:   data.access_token,
      phoneNumberId: data.phone_number_id,
      apiUrl:        (data.api_endpoint || process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v20.0').replace(/\/$/, ''),
      provider:      data.provider,
    };
  }

  const { data: botbiz } = await supabaseAdmin
    .from('restaurant_integrations')
    .select('access_token, phone_number_id, api_endpoint, provider')
    .eq('restaurant_id', restaurantId)
    .eq('channel', 'whatsapp')
    .eq('is_active', true)
    .eq('provider', 'botbiz')
    .maybeSingle();

  if (botbiz?.access_token && botbiz?.phone_number_id) {
    return {
      accessToken:   botbiz.access_token,
      phoneNumberId: botbiz.phone_number_id,
      apiUrl:        (botbiz.api_endpoint || process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v20.0').replace(/\/$/, ''),
      provider:      botbiz.provider,
    };
  }

  if (error) {
    console.warn(`[restaurantConfig] integration load failed for ${restaurantId}:`, error.message);
  }

  if (process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    console.warn(`[restaurantConfig] no integration row for ${restaurantId} — using global WHATSAPP_* env`);
    return {
      accessToken:   process.env.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      apiUrl:        (process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v20.0').replace(/\/$/, ''),
      provider:      'env',
    };
  }

  return null;
}

module.exports = {
  getManagerPhone,
  getOperationalAlertPhones,
  getMetaCatalogId,
  getWhatsAppIntegration,
  invalidateRestaurantConfigCache,
};
