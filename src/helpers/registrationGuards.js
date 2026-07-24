// src/helpers/registrationGuards.js
// Preflight uniqueness + verified rollback helpers for onboarding.

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { writeAuditLog } = require('./auditLog');

async function recordRegistrationFailure(entry) {
  const row = {
    email: entry.email || null,
    slug: entry.slug || null,
    restaurant_id: entry.restaurant_id || null,
    auth_user_id: entry.auth_user_id || null,
    failed_step: entry.failed_step || null,
    error_message: String(entry.error_message || '').slice(0, 2000) || null,
    meta: entry.meta || {},
    created_at: new Date().toISOString(),
  };
  try {
    const { error } = await supabaseAdmin.from('registration_failures').insert(row);
    if (error) {
      console.warn('[registration_failures] insert failed:', error.message);
      await writeAuditLog({
        restaurant_id: row.restaurant_id,
        actor_id: row.auth_user_id,
        action: 'registration.failure',
        entity_type: 'registration',
        entity_id: null,
        meta: row,
      });
    }
  } catch (err) {
    console.warn('[registration_failures]', err.message);
  }
}

/**
 * Fail if phone_number_id / waba_id / whatsapp_number already linked to another active tenant.
 */
async function assertWhatsAppAssetsAvailable({
  phone_number_id = null,
  waba_id = null,
  whatsapp_number = null,
  excludeRestaurantId = null,
} = {}) {
  if (phone_number_id) {
    let q = supabaseAdmin
      .from('tenant_integrations')
      .select('id, restaurant_id')
      .eq('phone_number_id', String(phone_number_id).trim())
      .eq('is_active', true)
      .limit(2);
    if (excludeRestaurantId) q = q.neq('restaurant_id', excludeRestaurantId);
    const { data, error } = await q;
    if (error) throw error;
    if (data?.length) {
      const err = new Error('This WhatsApp number is already connected to another Autom8 account');
      err.status = 409;
      err.code = 'whatsapp_number_taken';
      throw err;
    }
  }

  if (waba_id) {
    let q = supabaseAdmin
      .from('tenants')
      .select('id')
      .eq('waba_id', String(waba_id).trim())
      .eq('is_active', true)
      .limit(2);
    if (excludeRestaurantId) q = q.neq('id', excludeRestaurantId);
    const { data, error } = await q;
    if (error) throw error;
    if (data?.length) {
      const err = new Error('This WhatsApp Business Account is already linked to another Autom8 account');
      err.status = 409;
      err.code = 'waba_taken';
      throw err;
    }
  }

  if (whatsapp_number) {
    const digits = String(whatsapp_number).replace(/\D/g, '');
    if (digits) {
      let q = supabaseAdmin
        .from('tenants')
        .select('id')
        .eq('whatsapp_number', digits)
        .eq('is_active', true)
        .limit(2);
      if (excludeRestaurantId) q = q.neq('id', excludeRestaurantId);
      const { data, error } = await q;
      if (error) throw error;
      if (data?.length) {
        const err = new Error('This WhatsApp number is already connected to another Autom8 account');
        err.status = 409;
        err.code = 'whatsapp_number_taken';
        throw err;
      }
    }
  }
}

async function verifiedDeleteTenant(restaurantId) {
  if (!restaurantId) return { ok: true };
  // Remove child integrations first so tenant delete is not blocked by FK
  const { error: intErr } = await supabaseAdmin
    .from('tenant_integrations')
    .delete()
    .eq('restaurant_id', restaurantId);
  if (intErr) {
    console.error('[onboarding] failed deleting tenant_integrations:', intErr.message);
  }
  const { error } = await supabaseAdmin.from('tenants').delete().eq('id', restaurantId);
  if (error) {
    console.error('[onboarding] failed deleting tenant:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

async function verifiedDeleteAuthUser(authUserId) {
  if (!authUserId) return { ok: true };
  const { error } = await supabaseAdmin.auth.admin.deleteUser(authUserId);
  if (error) {
    console.error('[onboarding] failed deleting auth user:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

async function rollbackRegistration({
  restaurantId = null,
  authUserId = null,
  email = null,
  slug = null,
  failedStep = null,
  errorMessage = null,
} = {}) {
  const tenantResult = await verifiedDeleteTenant(restaurantId);
  const authResult = await verifiedDeleteAuthUser(authUserId);
  if (!tenantResult.ok || !authResult.ok) {
    await recordRegistrationFailure({
      email,
      slug,
      restaurant_id: restaurantId,
      auth_user_id: authUserId,
      failed_step: failedStep || 'rollback',
      error_message: errorMessage,
      meta: { tenantResult, authResult },
    });
  }
  return { tenantResult, authResult };
}

module.exports = {
  assertWhatsAppAssetsAvailable,
  recordRegistrationFailure,
  verifiedDeleteTenant,
  verifiedDeleteAuthUser,
  rollbackRegistration,
};
