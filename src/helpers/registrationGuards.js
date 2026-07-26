// src/helpers/registrationGuards.js
// Preflight uniqueness + verified rollback helpers for onboarding.

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { writeAuditLog } = require('./auditLog');

/** Comma-separated Meta phone_number_ids allowed to be shared across tenants (test only). */
function phoneNumberIdUniquenessExempt() {
  const fromEnv = String(process.env.WHATSAPP_PHONE_NUMBER_ID_UNIQUENESS_EXEMPT || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Known shared test MID (Autom8 multi-restaurant WhatsApp testing)
  const defaults = ['1086618881209069'];
  return new Set([...defaults, ...fromEnv]);
}

function isPhoneNumberIdExempt(phoneNumberId) {
  if (!phoneNumberId) return false;
  return phoneNumberIdUniquenessExempt().has(String(phoneNumberId).trim());
}

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
    const pid = String(phone_number_id).trim();
    if (isPhoneNumberIdExempt(pid)) {
      console.warn('[registrationGuards] skipping uniqueness check for exempt phone_number_id', pid);
    } else {
      let q = supabaseAdmin
        .from('tenant_integrations')
        .select('id, restaurant_id')
        .eq('phone_number_id', pid)
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

async function verifiedDeleteTenantEmployees(restaurantId) {
  if (!restaurantId) return { ok: true, employeeIds: [] };

  const { data: emps, error: listErr } = await supabaseAdmin
    .from('employees')
    .select('id, email')
    .eq('restaurant_id', restaurantId);
  if (listErr) {
    console.error('[onboarding] failed listing employees for rollback:', listErr.message);
    return { ok: false, error: listErr.message, employeeIds: [] };
  }

  const employeeIds = (emps || []).map((e) => e.id).filter(Boolean);
  if (!employeeIds.length) return { ok: true, employeeIds: [] };

  const { error: delErr } = await supabaseAdmin
    .from('employees')
    .delete()
    .eq('restaurant_id', restaurantId);
  if (delErr) {
    console.error('[onboarding] failed deleting employees on rollback:', delErr.message);
    return { ok: false, error: delErr.message, employeeIds };
  }

  return { ok: true, employeeIds };
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
    // Already deleted is fine during rollback
    if (/not found|user not found/i.test(error.message || '')) return { ok: true };
    console.error('[onboarding] failed deleting auth user:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Tear down a partial registration without leaving orphan employees
 * pointing at a deleted tenant (which defaults the portal to restaurant LOB).
 */
async function rollbackRegistration({
  restaurantId = null,
  authUserId = null,
  email = null,
  slug = null,
  failedStep = null,
  errorMessage = null,
} = {}) {
  const empResult = await verifiedDeleteTenantEmployees(restaurantId);
  const tenantResult = await verifiedDeleteTenant(restaurantId);

  const authIds = new Set(empResult.employeeIds || []);
  if (authUserId) authIds.add(authUserId);

  const authResults = [];
  for (const id of authIds) {
    authResults.push({ id, ...(await verifiedDeleteAuthUser(id)) });
  }
  const authOk = authResults.every((r) => r.ok !== false);

  await recordRegistrationFailure({
    email,
    slug,
    restaurant_id: restaurantId,
    auth_user_id: authUserId,
    failed_step: failedStep || 'rollback',
    error_message: errorMessage,
    meta: { empResult, tenantResult, authResults },
  });

  return {
    empResult,
    tenantResult,
    authResult: { ok: authOk, results: authResults },
  };
}

module.exports = {
  assertWhatsAppAssetsAvailable,
  recordRegistrationFailure,
  verifiedDeleteTenant,
  verifiedDeleteTenantEmployees,
  verifiedDeleteAuthUser,
  rollbackRegistration,
};
