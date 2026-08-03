'use strict';

/**
 * Resolve outbound WhatsApp credentials for supply notifications.
 *
 * Dedicated supplier WABA (suppliers.waba_*) wins when set.
 * Shared-WABA suppliers (Hi fnb) fall back to the Autom8 tenant's
 * tenant_integrations row — the same line clients already chat on.
 */

const { supabaseAdmin } = require('../config/supabase');
const { getActiveWhatsAppIntegration } = require('./tenantIntegrations');

const DEFAULT_API = 'https://graph.facebook.com/v19.0';

function _firstEnv(...keys) {
  for (const k of keys) {
    const v = (process.env[k] || '').trim();
    if (v) return v;
  }
  return null;
}

function _apiBase(override) {
  return (override || _firstEnv('SUPPLY_WHATSAPP_API_URL', 'BOTBIZ_API_ENDPOINT') || DEFAULT_API)
    .replace(/\/$/, '');
}

function _platformToken() {
  return _firstEnv(
    'SUPPLY_WHATSAPP_ACCESS_TOKEN',
    'META_WABA_TOKEN',
    'META_GRAPH_API_TOKEN',
    'BOTBIZ_ACCESS_TOKEN',
  );
}

async function _linkedRestaurantId(supplier) {
  if (!supplier) return null;

  if (supplier.auth_user_id) {
    const { data: emp } = await supabaseAdmin
      .from('employees')
      .select('restaurant_id')
      .eq('id', supplier.auth_user_id)
      .maybeSingle();
    if (emp?.restaurant_id) return emp.restaurant_id;
  }

  if (supplier.email) {
    const { data: emp } = await supabaseAdmin
      .from('employees')
      .select('restaurant_id')
      .ilike('email', supplier.email)
      .eq('role', 'owner')
      .limit(1)
      .maybeSingle();
    if (emp?.restaurant_id) return emp.restaurant_id;
  }

  return null;
}

/**
 * @param {string|null} supplierId
 * @returns {Promise<{ phoneNumberId: string, accessToken: string, apiUrl: string, fromPhone?: string|null, source: string } | null>}
 */
async function resolveSupplyWabaCredentials(supplierId = null) {
  let supplier = null;
  if (supplierId) {
    const { data, error } = await supabaseAdmin
      .from('suppliers')
      .select('id, auth_user_id, email, waba_phone_number_id, waba_phone')
      .eq('id', supplierId)
      .maybeSingle();
    if (!error) supplier = data;
  }

  const platformToken = _platformToken();

  // 1) Dedicated supplier WABA
  if (supplier?.waba_phone_number_id && platformToken) {
    return {
      phoneNumberId: supplier.waba_phone_number_id,
      accessToken: platformToken,
      apiUrl: _apiBase(),
      fromPhone: supplier.waba_phone || _firstEnv('SUPPLY_WHATSAPP_DISPLAY_PHONE'),
      source: 'supplier.waba',
    };
  }

  // 2) Shared-WABA / Autom8 tenant integration (same path chat uses for Hi fnb)
  try {
    const restaurantId = await _linkedRestaurantId(supplier);
    if (restaurantId) {
      const row = await getActiveWhatsAppIntegration(restaurantId);
      if (row?.phone_number_id && row?.access_token && String(row.access_token).length >= 20) {
        return {
          phoneNumberId: row.phone_number_id,
          accessToken: row.access_token,
          apiUrl: _apiBase(row.api_endpoint),
          fromPhone: supplier?.waba_phone || _firstEnv('SUPPLY_WHATSAPP_DISPLAY_PHONE'),
          source: 'tenant_integrations',
        };
      }
    }
  } catch (err) {
    console.warn('[supplyWaba] tenant integration lookup failed:', err.message);
  }

  // 3) Supply / platform env fallback
  const envPnid = _firstEnv(
    'SUPPLY_WHATSAPP_PHONE_NUMBER_ID',
    'WABA_PHONE_NUMBER_ID',
    'BOTBIZ_PHONE_NUMBER_ID',
  );
  if (envPnid && platformToken) {
    return {
      phoneNumberId: envPnid,
      accessToken: platformToken,
      apiUrl: _apiBase(),
      fromPhone: _firstEnv('SUPPLY_WHATSAPP_DISPLAY_PHONE'),
      source: 'env',
    };
  }

  return null;
}

module.exports = {
  resolveSupplyWabaCredentials,
};
