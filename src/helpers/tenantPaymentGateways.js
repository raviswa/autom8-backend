'use strict';

/**
 * Per-tenant payment gateway registry.
 * - PhonePe MID rows: partnership / audit (never stores salt keys).
 * - tenants.payment_provider: customer checkout preference (phonepe | razorpay)
 *   using platform Railway credentials — not per-tenant API secrets.
 */

const { supabaseAdmin } = require('../config/supabase');

const ALLOWED_STATUS = new Set(['pending', 'live', 'kyc_failed', 'inactive']);
const ALLOWED_PROVIDERS = new Set(['phonepe', 'razorpay']);

function getPhonePePartnerReferralUrl() {
  const raw = String(process.env.PHONEPE_PARTNER_REFERRAL_URL || '').trim();
  return raw || null;
}

function sanitizeGatewayInput(body = {}) {
  const merchant_id = String(body.merchant_id || '').trim();
  const merchant_name = body.merchant_name != null
    ? String(body.merchant_name).trim() || null
    : undefined;
  const partner_referral_code = body.partner_referral_code != null
    ? String(body.partner_referral_code).trim() || null
    : undefined;
  let status = body.status != null ? String(body.status).trim().toLowerCase() : undefined;
  if (status && !ALLOWED_STATUS.has(status)) {
    const err = new Error(`status must be one of: ${[...ALLOWED_STATUS].join(', ')}`);
    err.status = 400;
    throw err;
  }
  return { merchant_id, merchant_name, partner_referral_code, status };
}

async function getPhonePeGateway(restaurantId) {
  const { data, error } = await supabaseAdmin
    .from('tenant_payment_gateways')
    .select('id, restaurant_id, provider, merchant_id, merchant_name, partner_referral_code, status, linked_at, is_active, created_at, updated_at')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'phonepe')
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Upsert PhonePe merchant registry for an outlet.
 * Does not accept or store secrets. Requires merchant_id (self-report path).
 */
async function upsertPhonePeGateway(restaurantId, body = {}) {
  const input = sanitizeGatewayInput(body);
  if (!input.merchant_id) {
    const err = new Error('merchant_id is required');
    err.status = 400;
    throw err;
  }

  const existing = await getPhonePeGateway(restaurantId);
  const now = new Date().toISOString();
  const nextStatus = input.status || existing?.status || 'pending';
  const becameLive = nextStatus === 'live' && existing?.status !== 'live';

  const row = {
    restaurant_id: restaurantId,
    provider: 'phonepe',
    merchant_id: input.merchant_id,
    merchant_name: input.merchant_name !== undefined
      ? input.merchant_name
      : (existing?.merchant_name || null),
    partner_referral_code: input.partner_referral_code !== undefined
      ? input.partner_referral_code
      : (existing?.partner_referral_code || null),
    status: nextStatus,
    is_active: true,
    updated_at: now,
    linked_at: becameLive || (!existing?.linked_at && nextStatus === 'live')
      ? now
      : (existing?.linked_at || null),
  };

  const { data, error } = await supabaseAdmin
    .from('tenant_payment_gateways')
    .upsert(row, { onConflict: 'restaurant_id,provider' })
    .select('id, restaurant_id, provider, merchant_id, merchant_name, partner_referral_code, status, linked_at, is_active, created_at, updated_at')
    .single();

  if (error) throw error;
  return data;
}

/**
 * Record that the owner opened the PhonePe partner referral link.
 * Idempotent: does not clobber an existing row that already has a MID.
 */
async function markPhonePeReferralIntent(restaurantId) {
  if (!restaurantId) {
    const err = new Error('restaurant_id is required');
    err.status = 400;
    throw err;
  }

  const existing = await getPhonePeGateway(restaurantId);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('tenant_payment_gateways')
    .insert({
      restaurant_id: restaurantId,
      provider: 'phonepe',
      merchant_id: null,
      merchant_name: null,
      partner_referral_code: null,
      status: 'pending',
      is_active: true,
      linked_at: null,
      created_at: now,
      updated_at: now,
    })
    .select('id, restaurant_id, provider, merchant_id, merchant_name, partner_referral_code, status, linked_at, is_active, created_at, updated_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return getPhonePeGateway(restaurantId);
    }
    throw error;
  }
  return data;
}

function summarizePhonePeMerchant(gateway) {
  if (!gateway) {
    return {
      status: null,
      has_merchant_id: false,
      merchant_id: null,
    };
  }
  const mid = gateway.merchant_id != null ? String(gateway.merchant_id).trim() : '';
  return {
    status: gateway.status || null,
    has_merchant_id: Boolean(mid),
    merchant_id: mid || null,
  };
}

/** @returns {'phonepe'|'razorpay'|null} */
async function getPreferredPaymentProvider(restaurantId) {
  if (!restaurantId) return null;
  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select('payment_provider')
    .eq('id', restaurantId)
    .maybeSingle();
  if (error) throw error;
  const p = String(data?.payment_provider || '').trim().toLowerCase();
  return ALLOWED_PROVIDERS.has(p) ? p : null;
}

/**
 * Set customer checkout gateway preference for an outlet.
 * @returns {'phonepe'|'razorpay'}
 */
async function setPreferredPaymentProvider(restaurantId, provider) {
  if (!restaurantId) {
    const err = new Error('restaurant_id is required');
    err.status = 400;
    throw err;
  }
  const p = String(provider || '').trim().toLowerCase();
  if (!ALLOWED_PROVIDERS.has(p)) {
    const err = new Error("preferred_provider must be 'phonepe' or 'razorpay'");
    err.status = 400;
    throw err;
  }

  const { data, error } = await supabaseAdmin
    .from('tenants')
    .update({ payment_provider: p })
    .eq('id', restaurantId)
    .select('id, payment_provider')
    .single();

  if (error) throw error;
  return data.payment_provider;
}

/**
 * Ops bulk set. Returns { updated, failed }.
 */
async function bulkSetPreferredPaymentProvider(restaurantIds, provider) {
  const p = String(provider || '').trim().toLowerCase();
  if (!ALLOWED_PROVIDERS.has(p)) {
    const err = new Error("preferred_provider must be 'phonepe' or 'razorpay'");
    err.status = 400;
    throw err;
  }
  const ids = [...new Set((restaurantIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) {
    const err = new Error('restaurant_ids array is required');
    err.status = 400;
    throw err;
  }

  const { data, error } = await supabaseAdmin
    .from('tenants')
    .update({ payment_provider: p })
    .in('id', ids)
    .select('id, payment_provider');

  if (error) throw error;
  const updated = (data || []).map((r) => r.id);
  const failed = ids.filter((id) => !updated.includes(id));
  return { preferred_provider: p, updated, failed };
}

module.exports = {
  ALLOWED_STATUS,
  ALLOWED_PROVIDERS,
  getPhonePePartnerReferralUrl,
  getPhonePeGateway,
  upsertPhonePeGateway,
  markPhonePeReferralIntent,
  summarizePhonePeMerchant,
  getPreferredPaymentProvider,
  setPreferredPaymentProvider,
  bulkSetPreferredPaymentProvider,
};
