'use strict';

/**
 * Per-tenant payment gateway registry (PhonePe MID for partnership/audit).
 * Never stores salt keys or end-customer payment PII.
 */

const { supabaseAdmin } = require('../config/supabase');

const ALLOWED_STATUS = new Set(['pending', 'live', 'kyc_failed', 'inactive']);

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
    // Race: another request inserted — return that row
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

module.exports = {
  ALLOWED_STATUS,
  getPhonePePartnerReferralUrl,
  getPhonePeGateway,
  upsertPhonePeGateway,
  markPhonePeReferralIntent,
  summarizePhonePeMerchant,
};
