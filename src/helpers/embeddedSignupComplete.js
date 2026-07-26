// src/helpers/embeddedSignupComplete.js
// Shared Tech Provider Embedded Signup completion (Graph + DB persist).
// Used by Settings POST /complete and website onboarding/register.

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { invalidateRestaurantConfigCache } = require('./restaurantConfig');
const { writeAuditLog } = require('./auditLog');
const { assertWhatsAppAssetsAvailable } = require('./registrationGuards');

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
    existing_pin = null,
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

  await assertWhatsAppAssetsAvailable({
    phone_number_id,
    waba_id,
    excludeRestaurantId: restaurantId,
  });

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

  const pinFromUser = existing_pin != null
    ? String(existing_pin).replace(/\D/g, '').slice(0, 6)
    : '';
  const pin = pinFromUser
    || (process.env.WHATSAPP_REGISTER_PIN || '').replace(/\D/g).slice(0, 6)
    || randomSixDigitPin();
  if (pin.length !== 6) {
    const err = new Error('A 6-digit WhatsApp PIN is required to register this number');
    err.status = 400;
    err.code = 'needs_existing_pin';
    throw err;
  }

  let needsExistingPin = false;
  try {
    await graphPost(`/${phone_number_id}/register`, businessToken, {
      messaging_product: 'whatsapp',
      pin,
    });
  } catch (regErr) {
    const msg = String(regErr.message || '');
    const already = /already registered|is registered/i.test(msg)
      || regErr.graph?.code === 133016;
    const pinIssue = /pin|two.?step|2fa|two-step/i.test(msg)
      || [133005, 133006, 133008, 133009].includes(Number(regErr.graph?.code));
    if (already) {
      console.warn(`[embedded-signup] phone ${phone_number_id} already registered — continuing`);
    } else if (pinIssue) {
      // Persist credentials below so Screen A can collect the existing PIN and retry.
      needsExistingPin = true;
      console.warn(`[embedded-signup] phone ${phone_number_id} needs existing PIN — persisting and flagging`);
    } else {
      throw regErr;
    }
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
    whatsapp_needs_existing_pin: needsExistingPin,
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
    whatsapp_needs_existing_pin: needsExistingPin,
  };
}

/**
 * Retry Graph /register with the number's existing 2FA PIN (migration case).
 */
async function registerPhoneWithExistingPin(restaurantId, existingPin, actorId = null) {
  const pin = String(existingPin || '').replace(/\D/g, '').slice(0, 6);
  if (pin.length !== 6) {
    const err = new Error('Enter the 6-digit WhatsApp PIN for this number');
    err.status = 400;
    err.code = 'needs_existing_pin';
    throw err;
  }

  const { data: integration } = await supabaseAdmin
    .from('tenant_integrations')
    .select('id, phone_number_id, access_token, config')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'meta')
    .eq('channel', 'whatsapp')
    .eq('is_active', true)
    .maybeSingle();

  if (!integration?.phone_number_id || !integration?.access_token) {
    const err = new Error('WhatsApp is not linked yet — connect WhatsApp first');
    err.status = 400;
    throw err;
  }

  try {
    await graphPost(`/${integration.phone_number_id}/register`, integration.access_token, {
      messaging_product: 'whatsapp',
      pin,
    });
  } catch (regErr) {
    const msg = String(regErr.message || '');
    const already = /already registered|is registered/i.test(msg)
      || regErr.graph?.code === 133016;
    if (!already) {
      const err = new Error(msg || 'PIN was rejected by Meta — check and try again');
      err.status = 400;
      err.code = 'needs_existing_pin';
      err.graph = regErr.graph;
      throw err;
    }
  }

  await supabaseAdmin
    .from('tenants')
    .update({
      whatsapp_needs_existing_pin: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', restaurantId);

  await writeAuditLog({
    restaurant_id: restaurantId,
    actor_id: actorId,
    action: 'whatsapp.embedded_signup.register_pin',
    entity_type: 'tenant_integrations',
    entity_id: integration.id,
    meta: { phone_number_id: integration.phone_number_id },
  });

  return { success: true, whatsapp_needs_existing_pin: false };
}

/**
 * Account status panel data for Settings / Screen A.
 */
async function getWhatsAppAccountStatus(restaurantId) {
  const [{ data: tenant }, { data: integration }] = await Promise.all([
    supabaseAdmin
      .from('tenants')
      .select('id, name, display_name, waba_id, whatsapp_number, whatsapp_needs_existing_pin, lob_type, updated_at')
      .eq('id', restaurantId)
      .maybeSingle(),
    supabaseAdmin
      .from('tenant_integrations')
      .select('id, phone_number_id, waba_id, is_active, updated_at, config')
      .eq('restaurant_id', restaurantId)
      .eq('provider', 'meta')
      .eq('channel', 'whatsapp')
      .eq('is_active', true)
      .maybeSingle(),
  ]);

  if (!tenant) {
    const err = new Error('Restaurant not found');
    err.status = 404;
    err.code = 'tenant_missing';
    throw err;
  }

  const connected = Boolean(integration?.id && integration?.phone_number_id);
  return {
    connected,
    business_name: tenant.display_name || tenant.name,
    lob_type: tenant.lob_type || 'restaurant',
    whatsapp_number: tenant.whatsapp_number || null,
    waba_id: tenant.waba_id || integration?.waba_id || null,
    phone_number_id: integration?.phone_number_id || null,
    whatsapp_needs_existing_pin: Boolean(tenant.whatsapp_needs_existing_pin),
    integration_id: integration?.id || null,
    last_updated_at: integration?.updated_at || tenant.updated_at || null,
    billing_path: '/billing',
  };
}

/**
 * Read-only Meta message_templates for the connected WABA.
 */
async function listMessageTemplatesForRestaurant(restaurantId) {
  const { data: integration } = await supabaseAdmin
    .from('tenant_integrations')
    .select('id, waba_id, access_token, phone_number_id, is_active')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'meta')
    .eq('channel', 'whatsapp')
    .eq('is_active', true)
    .maybeSingle();

  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('waba_id')
    .eq('id', restaurantId)
    .maybeSingle();

  const wabaId = integration?.waba_id || tenant?.waba_id;
  const token = integration?.access_token;

  if (!wabaId || !token) {
    const err = new Error('Connect WhatsApp before viewing message templates');
    err.status = 400;
    err.code = 'whatsapp_not_connected';
    throw err;
  }

  const data = await graphGet(`/${wabaId}/message_templates`, {
    access_token: token,
    fields: 'name,status,category,language,id',
    limit: 100,
  });

  const templates = (data?.data || []).map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    category: t.category,
    language: t.language,
  }));

  return {
    waba_id: wabaId,
    templates,
    count: templates.length,
  };
}

module.exports = {
  completeEmbeddedSignupForRestaurant,
  registerPhoneWithExistingPin,
  getPublicEmbeddedSignupConfig,
  isEmbeddedSignupConfigured,
  getWhatsAppAccountStatus,
  listMessageTemplatesForRestaurant,
  graphGet,
  graphPost,
  normalizeWhatsAppNumber,
};
