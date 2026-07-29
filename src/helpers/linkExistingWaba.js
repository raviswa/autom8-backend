'use strict';

/**
 * Attach an already-live Autom8 WhatsApp integration onto a target restaurant.
 * Used by POST /onboarding/link-existing-waba and demo auto-heal paths.
 */

const { supabaseAdmin } = require('../config/supabase');
const { findTenantByWaba, normalizeWabaDigits } = require('./referrals');
const { normalizeWhatsAppNumber } = require('./embeddedSignupComplete');
const { isPhoneNumberIdExempt } = require('./registrationGuards');
const { isLifetimeTenant, getDemoWhatsAppNumber } = require('./subscriptionAccess');
const { invalidateRestaurantConfigCache } = require('./restaurantConfig');
const { writeAuditLog } = require('./auditLog');
const { recordActivationEvent } = require('./tenantActivation');
const {
  getActiveWhatsAppIntegration,
  upsertWhatsAppIntegration,
} = require('./tenantIntegrations');

function isHotelMunafeDemoName(tenant = {}) {
  const blob = `${tenant.name || ''} ${tenant.display_name || ''}`.toLowerCase();
  return /hotel\s*munafe/.test(blob);
}

function isDemoOutlet(restaurantId, tenant = null) {
  if (isLifetimeTenant(restaurantId)) return true;
  if (tenant && isHotelMunafeDemoName(tenant)) return true;
  return false;
}

/**
 * @param {string} restaurantId
 * @param {{ whatsappNumber?: string|null, actorId?: string|null, allowNonLifetime?: boolean }} [opts]
 */
async function linkExistingWabaToRestaurant(restaurantId, opts = {}) {
  if (!restaurantId) {
    const err = new Error('restaurant_id is required');
    err.status = 400;
    throw err;
  }

  const lifetime = isLifetimeTenant(restaurantId);
  const rawDigits = String(
    opts.whatsappNumber || getDemoWhatsAppNumber() || '',
  ).trim();
  const digits = normalizeWabaDigits(rawDigits);
  if (digits.length < 10) {
    const err = new Error('whatsapp_number / waba digits required');
    err.status = 400;
    throw err;
  }

  const { data: targetTenant } = await supabaseAdmin
    .from('tenants')
    .select('id, name, display_name, waba_id, whatsapp_number')
    .eq('id', restaurantId)
    .maybeSingle();

  const demo = isDemoOutlet(restaurantId, targetTenant);
  if (!lifetime && !demo && !opts.allowNonLifetime) {
    // Still allow if phone is uniqueness-exempt (checked after we find source)
  }

  const source = await findTenantByWaba(digits);
  if (!source?.id) {
    const err = new Error('No Autom8 account found with that WhatsApp number');
    err.status = 404;
    err.code = 'waba_not_found';
    throw err;
  }

  if (source.id === restaurantId) {
    const own = await getActiveWhatsAppIntegration(restaurantId);
    if (!own) {
      const { data: inactive } = await supabaseAdmin
        .from('tenant_integrations')
        .select('id, is_active')
        .eq('restaurant_id', restaurantId)
        .eq('provider', 'meta')
        .eq('channel', 'whatsapp')
        .maybeSingle();
      if (inactive?.id && !inactive.is_active) {
        await supabaseAdmin
          .from('tenant_integrations')
          .update({ is_active: true, updated_at: new Date().toISOString() })
          .eq('id', inactive.id);
      }
    }
    await supabaseAdmin
      .from('tenants')
      .update({ whatsapp_needs_existing_pin: false, updated_at: new Date().toISOString() })
      .eq('id', restaurantId);
    return { success: true, linked: true, already_owned: true };
  }

  const { data: srcTenant } = await supabaseAdmin
    .from('tenants')
    .select('id, waba_id, whatsapp_number, whatsapp_needs_existing_pin')
    .eq('id', source.id)
    .maybeSingle();

  const srcInt = await getActiveWhatsAppIntegration(source.id);

  if (!srcInt?.phone_number_id || !srcInt?.access_token) {
    const err = new Error('Source WhatsApp credentials are incomplete');
    err.status = 404;
    err.code = 'source_integration_missing';
    throw err;
  }

  if (!lifetime && !demo && !isPhoneNumberIdExempt(srcInt.phone_number_id)) {
    const err = new Error('Linking an existing WhatsApp is only available for Autom8 demo outlets');
    err.status = 403;
    err.code = 'link_not_allowed';
    throw err;
  }

  const now = new Date().toISOString();
  const wabaId = srcTenant?.waba_id || srcInt.waba_id || null;
  const waNumber = normalizeWhatsAppNumber(srcTenant?.whatsapp_number || digits);

  if ((lifetime || demo) && !isPhoneNumberIdExempt(srcInt.phone_number_id)) {
    await supabaseAdmin
      .from('tenant_integrations')
      .update({ is_active: false, updated_at: now })
      .eq('id', srcInt.id);
  }

  await supabaseAdmin
    .from('tenants')
    .update({
      waba_id: wabaId,
      whatsapp_number: waNumber,
      whatsapp_needs_existing_pin: false,
      updated_at: now,
    })
    .eq('id', restaurantId);

  const integrationPayload = {
    phone_number_id: String(srcInt.phone_number_id),
    access_token: srcInt.access_token,
    waba_id: wabaId ? String(wabaId) : null,
    is_active: true,
    updated_at: now,
    webhook_secret: srcInt.webhook_secret || null,
    webhook_verify_token: srcInt.webhook_verify_token || null,
    config: {
      ...(srcInt.config && typeof srcInt.config === 'object' ? srcInt.config : {}),
      linked_from_restaurant_id: source.id,
      linked_at: now,
    },
  };

  const integration = await upsertWhatsAppIntegration(restaurantId, integrationPayload);

  invalidateRestaurantConfigCache(restaurantId);

  await writeAuditLog({
    restaurant_id: restaurantId,
    actor_id: opts.actorId || null,
    action: 'whatsapp.link_existing_waba',
    entity_type: 'tenant_integrations',
    entity_id: integration?.id || null,
    meta: {
      source_restaurant_id: source.id,
      whatsapp_number: waNumber,
      waba_id: wabaId,
      auto: Boolean(opts.auto),
    },
  });

  recordActivationEvent(restaurantId, 'whatsapp_connected', {
    source: opts.auto ? 'link_existing_auto' : 'link_existing',
  }).catch(() => {});

  return {
    success: true,
    linked: true,
    whatsapp_number: waNumber,
    waba_id: wabaId,
    integration_id: integration?.id || null,
  };
}

/**
 * True when a stored access_token is clearly a placeholder that will never
 * pass Meta auth.  Mirrors the Python-side _is_placeholder_token check.
 */
function _isPlaceholderToken(token) {
  if (!token || typeof token !== 'string') return true;
  const t = token.trim();
  if (t.length < 20) return true;
  return /^(demo\d*|your_access_token|placeholder|changeme|test\d*|fake_token|demotoken)/i.test(t);
}

/**
 * If this is a demo outlet with no active WA (or with a placeholder token),
 * try to attach DEMO_WHATSAPP_NUMBER.  Never throws — logs and returns null on failure.
 *
 * Previously the function would skip re-linking when `active.phone_number_id`
 * was set, even if the stored token was a placeholder (e.g. 'demo1234').
 * That caused silent Meta 401s on every outbound message for those outlets.
 */
async function autoLinkDemoWhatsAppIfNeeded(restaurantId, tenantRow = null) {
  try {
    if (!restaurantId) return null;
    const { data: tenant } = tenantRow
      ? { data: tenantRow }
      : await supabaseAdmin
        .from('tenants')
        .select('id, name, display_name, waba_id, whatsapp_number')
        .eq('id', restaurantId)
        .maybeSingle();

    if (!isDemoOutlet(restaurantId, tenant)) return null;

    const active = await getActiveWhatsAppIntegration(restaurantId);
    const hasFields = Boolean(
      (tenant?.waba_id && String(tenant.waba_id).trim())
      && (tenant?.whatsapp_number && String(tenant.whatsapp_number).replace(/\D/g, '').length >= 10),
    );

    // Skip re-linking ONLY when the existing row has a real (non-placeholder) token.
    const hasRealToken = active?.phone_number_id && !_isPlaceholderToken(active?.access_token);
    if (hasRealToken && hasFields) return null;

    if (active?.phone_number_id && _isPlaceholderToken(active?.access_token)) {
      console.warn('[demo-waba] placeholder token detected — forcing re-link', {
        restaurantId,
        phone_number_id: active.phone_number_id,
        token_prefix: String(active.access_token || '').slice(0, 12),
      });
    }

    const demoDigits = getDemoWhatsAppNumber();
    if (!demoDigits) return null;

    console.warn('[demo-waba] auto-linking demo WhatsApp onto outlet', {
      restaurantId,
      name: tenant?.display_name || tenant?.name,
      demoDigits,
    });
    return await linkExistingWabaToRestaurant(restaurantId, {
      whatsappNumber: demoDigits,
      auto: true,
    });
  } catch (err) {
    console.warn('[demo-waba] auto-link skipped:', err.message);
    return null;
  }
}

module.exports = {
  isHotelMunafeDemoName,
  isDemoOutlet,
  getActiveWhatsAppIntegration,
  linkExistingWabaToRestaurant,
  autoLinkDemoWhatsAppIfNeeded,
};
