'use strict';

/**
 * Voluntary WhatsApp release — free a number/WABA so it can be linked to another Autom8 account.
 *
 * Distinct from subscription soft-lock (non-payment): soft-lock keeps the WA binding
 * so the owner can renew and keep the same number. Delete / disconnect must release it.
 */

const { supabaseAdmin } = require('../config/supabase');
const { invalidateRestaurantConfigCache } = require('./restaurantConfig');
const { invalidatePhoneCache } = require('./resolveRestaurant');

const GRAPH_VERSION = () => process.env.META_GRAPH_VERSION || 'v21.0';

async function bestEffortUnsubscribeMeta(row) {
  const token = row?.access_token;
  const wabaId = row?.waba_id;
  if (!token || !wabaId) return { ok: false, reason: 'missing_token_or_waba' };

  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION()}/${encodeURIComponent(wabaId)}/subscribed_apps`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[releaseWhatsApp] subscribed_apps DELETE', res.status, body.slice(0, 300));
      return { ok: false, reason: `meta_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[releaseWhatsApp] subscribed_apps:', err.message);
    return { ok: false, reason: err.message };
  }
}

/**
 * Release all WhatsApp (and any channel) integrations for an outlet so the
 * Meta phone_number_id / display number can be claimed by another tenant.
 *
 * @param {string} restaurantId
 * @param {{ reason?: string, actorId?: string|null }} [opts]
 * @returns {Promise<{ released: boolean, phone_number_ids: string[], steps: object }>}
 */
async function releaseWhatsAppBinding(restaurantId, opts = {}) {
  if (!restaurantId) {
    return { released: false, phone_number_ids: [], steps: { error: 'missing_restaurant_id' } };
  }

  const now = new Date().toISOString();
  const reason = String(opts.reason || 'account_delete').slice(0, 80);
  const steps = {
    meta_unsubscribed: false,
    integrations_released: false,
    tenant_wa_cleared: false,
    phone_cache_cleared: false,
  };
  const phoneNumberIds = [];

  const { data: rows, error: listErr } = await supabaseAdmin
    .from('tenant_integrations')
    .select('id, phone_number_id, waba_id, access_token, channel, provider, is_active, config')
    .eq('restaurant_id', restaurantId)
    .eq('channel', 'whatsapp');

  if (listErr) {
    console.warn('[releaseWhatsApp] list integrations:', listErr.message);
  }

  const integrations = rows || [];
  for (const row of integrations) {
    if (row.phone_number_id) phoneNumberIds.push(String(row.phone_number_id));
    if (row.is_active && row.access_token && row.waba_id) {
      const unsub = await bestEffortUnsubscribeMeta(row);
      if (unsub.ok) steps.meta_unsubscribed = true;
    }
  }

  // Clear credentials + MID so uniqueness (and any non-partial unique) cannot block re-link.
  for (const row of integrations) {
    const priorConfig = (row.config && typeof row.config === 'object') ? row.config : {};
    const update = {
      is_active: false,
      phone_number_id: null,
      access_token: null,
      waba_id: null,
      webhook_secret: null,
      config: {
        ...priorConfig,
        released_at: now,
        release_reason: reason,
        prior_phone_number_id: row.phone_number_id || priorConfig.prior_phone_number_id || null,
        prior_waba_id: row.waba_id || priorConfig.prior_waba_id || null,
      },
      updated_at: now,
    };

    let { error: updErr } = await supabaseAdmin
      .from('tenant_integrations')
      .update(update)
      .eq('id', row.id);

    if (updErr && /waba_id|webhook_secret|column/i.test(updErr.message || '')) {
      // Older schemas: clear what we can.
      ({ error: updErr } = await supabaseAdmin
        .from('tenant_integrations')
        .update({
          is_active: false,
          phone_number_id: null,
          access_token: null,
          updated_at: now,
        })
        .eq('id', row.id));
    }
    if (updErr) {
      console.warn('[releaseWhatsApp] integration update:', updErr.message);
    } else {
      steps.integrations_released = true;
    }
  }

  // Also force-deactivate any leftover active rows (non-whatsapp or race).
  await supabaseAdmin
    .from('tenant_integrations')
    .update({ is_active: false, updated_at: now })
    .eq('restaurant_id', restaurantId)
    .eq('is_active', true);

  const { error: tenantErr } = await supabaseAdmin
    .from('tenants')
    .update({
      waba_id: null,
      whatsapp_number: null,
      whatsapp_needs_existing_pin: false,
      updated_at: now,
    })
    .eq('id', restaurantId);

  if (tenantErr) {
    // Partial schema fallback
    const { error: fallbackErr } = await supabaseAdmin
      .from('tenants')
      .update({
        waba_id: null,
        whatsapp_number: null,
        updated_at: now,
      })
      .eq('id', restaurantId);
    if (fallbackErr) {
      console.warn('[releaseWhatsApp] tenant WA clear:', fallbackErr.message);
    } else {
      steps.tenant_wa_cleared = true;
    }
  } else {
    steps.tenant_wa_cleared = true;
  }

  for (const pnid of phoneNumberIds) {
    try {
      invalidatePhoneCache(pnid);
      steps.phone_cache_cleared = true;
    } catch (_) { /* non-fatal */ }
  }

  try {
    invalidateRestaurantConfigCache(restaurantId);
  } catch (_) { /* non-fatal */ }

  return {
    released: steps.integrations_released || steps.tenant_wa_cleared || integrations.length === 0,
    phone_number_ids: phoneNumberIds,
    steps,
  };
}

module.exports = { releaseWhatsAppBinding };
