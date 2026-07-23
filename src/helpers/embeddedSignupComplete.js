// src/helpers/embeddedSignupComplete.js
// Shared Tech Provider Embedded Signup completion (Graph + DB persist).
// Used by Settings POST /complete and website onboarding/register.

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { invalidateRestaurantConfigCache } = require('./restaurantConfig');
const { writeAuditLog } = require('./auditLog');

const GRAPH_VERSION = () => process.env.META_GRAPH_VERSION || 'v21.0';

function graphBase() {
  return `https://graph.facebook.com/${GRAPH_VERSION()}`;
}

function normalizeWhatsAppNumber(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits || null;
}

function randomSixDigitPin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isEmbeddedSignupConfigured() {
  return Boolean(
    process.env.META_APP_ID
    && process.env.META_APP_SECRET
    && process.env.META_EMBEDDED_SIGNUP_CONFIG_ID,
  );
}

function getPublicEmbeddedSignupConfig() {
  const appId = process.env.META_APP_ID || '';
  const configId = process.env.META_EMBEDDED_SIGNUP_CONFIG_ID || '';
  const solutionId = process.env.META_EMBEDDED_SIGNUP_SOLUTION_ID || '';
  const enabled = Boolean(appId && configId);
  return {
    enabled,
    appId: enabled ? appId : null,
    configId: enabled ? configId : null,
    solutionId: enabled && solutionId ? solutionId : null,
    graphVersion: GRAPH_VERSION(),
  };
}

async function graphGet(path, params = {}) {
  const url = new URL(`${graphBase()}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(30_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Graph GET ${path} failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.graph = data?.error;
    throw err;
  }
  return data;
}

async function graphPost(path, accessToken, body) {
  const url = `${graphBase()}${path}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body:   JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Graph POST ${path} failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.graph = data?.error;
    throw err;
  }
  return data;
}

/**
 * Exchange ES code, subscribe WABA, register phone, write tenants + tenant_integrations.
 *
 * @param {string} restaurantId
 * @param {{ code: string, waba_id: string, phone_number_id: string, display_phone_number?: string|null, actorId?: string|null }} opts
 */
async function completeEmbeddedSignupForRestaurant(restaurantId, opts) {
  const {
    code,
    waba_id,
    phone_number_id,
    display_phone_number = null,
    actorId = null,
  } = opts || {};

  if (!isEmbeddedSignupConfigured()) {
    const err = new Error('Embedded Signup is not configured on the server');
    err.status = 503;
    throw err;
  }
  if (!restaurantId) {
    const err = new Error('restaurantId is required');
    err.status = 400;
    throw err;
  }
  if (!code?.trim()) {
    const err = new Error('code is required');
    err.status = 400;
    throw err;
  }
  if (!waba_id) {
    const err = new Error('waba_id is required');
    err.status = 400;
    throw err;
  }
  if (!phone_number_id) {
    const err = new Error('phone_number_id is required');
    err.status = 400;
    throw err;
  }

  const tokenPayload = await graphGet('/oauth/access_token', {
    client_id:     process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    code:          code.trim(),
  });
  const businessToken = tokenPayload.access_token;
  if (!businessToken) {
    const err = new Error('Meta did not return an access_token for the signup code');
    err.status = 502;
    throw err;
  }

  await graphPost(`/${waba_id}/subscribed_apps`, businessToken, {});

  const pin = (process.env.WHATSAPP_REGISTER_PIN || '').replace(/\D/g).slice(0, 6)
    || randomSixDigitPin();
  if (pin.length !== 6) {
    const err = new Error('WHATSAPP_REGISTER_PIN must be a 6-digit PIN');
    err.status = 500;
    throw err;
  }

  try {
    await graphPost(`/${phone_number_id}/register`, businessToken, {
      messaging_product: 'whatsapp',
      pin,
    });
  } catch (regErr) {
    const msg = String(regErr.message || '');
    const already = /already registered|is registered/i.test(msg)
      || regErr.graph?.code === 133016;
    if (!already) throw regErr;
    console.warn(`[embedded-signup] phone ${phone_number_id} already registered — continuing`);
  }

  let displayPhone = display_phone_number;
  if (!displayPhone) {
    try {
      const phoneMeta = await graphGet(`/${phone_number_id}`, {
        fields: 'display_phone_number,verified_name',
        access_token: businessToken,
      });
      displayPhone = phoneMeta.display_phone_number || null;
    } catch (metaErr) {
      console.warn('[embedded-signup] could not fetch display_phone_number:', metaErr.message);
    }
  }

  const whatsappNumber = normalizeWhatsAppNumber(displayPhone);

  const tenantUpdates = {
    waba_id: String(waba_id),
    updated_at: new Date().toISOString(),
  };
  if (whatsappNumber) tenantUpdates.whatsapp_number = whatsappNumber;

  const { error: tenantErr } = await supabaseAdmin
    .from('tenants')
    .update(tenantUpdates)
    .eq('id', restaurantId);
  if (tenantErr) throw tenantErr;

  const integrationPayload = {
    provider:        'meta',
    channel:         'whatsapp',
    phone_number_id: String(phone_number_id),
    access_token:    businessToken,
    is_active:       true,
    updated_at:      new Date().toISOString(),
    config: {
      embedded_signup: true,
      register_pin_set: true,
      onboarded_at: new Date().toISOString(),
    },
  };

  const { data: existing } = await supabaseAdmin
    .from('tenant_integrations')
    .select('id, config')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'meta')
    .eq('channel', 'whatsapp')
    .maybeSingle();

  let integration;
  if (existing) {
    const mergedConfig = {
      ...(existing.config && typeof existing.config === 'object' ? existing.config : {}),
      ...integrationPayload.config,
    };
    const { data, error } = await supabaseAdmin
      .from('tenant_integrations')
      .update({ ...integrationPayload, config: mergedConfig })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    integration = data;
  } else {
    const { data, error } = await supabaseAdmin
      .from('tenant_integrations')
      .insert({
        restaurant_id: restaurantId,
        ...integrationPayload,
      })
      .select()
      .single();
    if (error) throw error;
    integration = data;
  }

  invalidateRestaurantConfigCache(restaurantId);

  await writeAuditLog({
    restaurant_id: restaurantId,
    actor_id:      actorId,
    action:        'whatsapp.embedded_signup.complete',
    entity_type:   'tenant_integrations',
    entity_id:     integration?.id || null,
    meta: {
      waba_id: String(waba_id),
      phone_number_id: String(phone_number_id),
      whatsapp_number: whatsappNumber,
    },
  });

  return {
    success: true,
    waba_id: String(waba_id),
    phone_number_id: String(phone_number_id),
    whatsapp_number: whatsappNumber,
    integration_id: integration?.id || null,
    access_token: businessToken,
  };
}

module.exports = {
  completeEmbeddedSignupForRestaurant,
  getPublicEmbeddedSignupConfig,
  isEmbeddedSignupConfigured,
  normalizeWhatsAppNumber,
};
