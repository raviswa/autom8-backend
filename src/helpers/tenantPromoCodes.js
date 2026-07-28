'use strict';

/**
 * Restaurant/LOB customer promo codes for webcart.
 * Distinct from platform subscription_offers.
 */

const { supabaseAdmin } = require('../config/supabase');

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function isOfferCurrentlyValid(row, now = Date.now()) {
  if (!row || !row.is_active) return false;
  if (row.valid_from && new Date(row.valid_from).getTime() > now) return false;
  if (row.valid_until && new Date(row.valid_until).getTime() < now) return false;
  if (row.max_redemptions != null && Number(row.redemption_count || 0) >= Number(row.max_redemptions)) {
    return false;
  }
  return true;
}

function computeDiscount({ discount_type, discount_value }, subtotal) {
  const sub = Math.max(0, Number(subtotal) || 0);
  const value = Math.max(0, Number(discount_value) || 0);
  let amount = 0;
  if (discount_type === 'percent') {
    amount = Math.round(sub * (value / 100));
  } else {
    amount = Math.round(value);
  }
  amount = Math.min(amount, Math.round(sub));
  return Math.max(0, amount);
}

async function listPromoCodes(restaurantId, { activeOnly = false } = {}) {
  let q = supabaseAdmin
    .from('tenant_promo_codes')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false });
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function getActivePromotionsForSession(restaurantId) {
  const rows = await listPromoCodes(restaurantId, { activeOnly: true });
  const now = Date.now();
  return rows
    .filter((r) => isOfferCurrentlyValid(r, now))
    .map((r) => ({
      id: r.id,
      code: r.code,
      discount_type: r.discount_type,
      discount_value: Number(r.discount_value),
      min_order_amount: r.min_order_amount != null ? Number(r.min_order_amount) : null,
    }));
}

async function findPromoByCode(restaurantId, code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const { data, error } = await supabaseAdmin
    .from('tenant_promo_codes')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('code', normalized)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * Validate + compute discount for checkout.
 * Returns { ok, amount, code, promo } or { ok:false, error }.
 */
async function applyPromoToSubtotal(restaurantId, code, subtotal) {
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: true, amount: 0, code: null, promo: null };

  const promo = await findPromoByCode(restaurantId, normalized);
  if (!promo || !isOfferCurrentlyValid(promo)) {
    return { ok: false, error: 'Promo code is invalid or expired' };
  }
  const sub = Math.max(0, Number(subtotal) || 0);
  if (promo.min_order_amount != null && sub < Number(promo.min_order_amount)) {
    return {
      ok: false,
      error: `Minimum order ₹${Number(promo.min_order_amount).toFixed(0)} required for this promo`,
    };
  }
  const amount = computeDiscount(promo, sub);
  return { ok: true, amount, code: promo.code, promo };
}

async function recordPromoRedemption({
  promo,
  restaurantId,
  orderId = null,
  customerPhone = null,
  discountAmount = 0,
}) {
  if (!promo?.id) return;
  await supabaseAdmin
    .from('tenant_promo_codes')
    .update({
      redemption_count: Number(promo.redemption_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', promo.id);

  await supabaseAdmin.from('tenant_promo_redemptions').insert({
    promo_code_id: promo.id,
    restaurant_id: restaurantId,
    order_id: orderId,
    customer_phone: customerPhone || null,
    discount_amount: Number(discountAmount) || 0,
    code_snapshot: promo.code,
  }).catch((e) => console.warn('[tenantPromo] redemption insert failed:', e.message));
}

async function createPromoCode(restaurantId, body = {}) {
  const code = normalizeCode(body.code);
  if (!code) {
    const err = new Error('code is required');
    err.status = 400;
    throw err;
  }
  if (!['percent', 'flat'].includes(body.discount_type)) {
    const err = new Error('discount_type must be percent or flat');
    err.status = 400;
    throw err;
  }
  const discount_value = Number(body.discount_value);
  if (!Number.isFinite(discount_value) || discount_value < 0) {
    const err = new Error('discount_value must be a non-negative number');
    err.status = 400;
    throw err;
  }
  if (body.discount_type === 'percent' && discount_value > 100) {
    const err = new Error('percent discount cannot exceed 100');
    err.status = 400;
    throw err;
  }

  const { data, error } = await supabaseAdmin
    .from('tenant_promo_codes')
    .insert({
      restaurant_id: restaurantId,
      code,
      discount_type: body.discount_type,
      discount_value,
      min_order_amount: body.min_order_amount != null ? Number(body.min_order_amount) : null,
      max_redemptions: body.max_redemptions != null ? Number(body.max_redemptions) : null,
      valid_from: body.valid_from || null,
      valid_until: body.valid_until || null,
      is_active: body.is_active !== false,
    })
    .select('*')
    .single();

  if (error) {
    const err = new Error(error.message);
    err.status = 400;
    throw err;
  }
  return data;
}

async function updatePromoCode(restaurantId, id, body = {}) {
  const allowed = [
    'discount_type',
    'discount_value',
    'min_order_amount',
    'max_redemptions',
    'valid_from',
    'valid_until',
    'is_active',
    'code',
  ];
  const updates = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key];
  }
  if (updates.code != null) updates.code = normalizeCode(updates.code);
  if (updates.discount_type && !['percent', 'flat'].includes(updates.discount_type)) {
    const err = new Error('discount_type must be percent or flat');
    err.status = 400;
    throw err;
  }
  if (updates.discount_value != null) updates.discount_value = Number(updates.discount_value);

  const { data, error } = await supabaseAdmin
    .from('tenant_promo_codes')
    .update(updates)
    .eq('id', id)
    .eq('restaurant_id', restaurantId)
    .select('*')
    .single();

  if (error) {
    const err = new Error(error.message);
    err.status = 400;
    throw err;
  }
  if (!data) {
    const err = new Error('Promo not found');
    err.status = 404;
    throw err;
  }
  return data;
}

async function listRedemptions(restaurantId, promoId, { limit = 50 } = {}) {
  let q = supabaseAdmin
    .from('tenant_promo_redemptions')
    .select('id, promo_code_id, order_id, customer_phone, discount_amount, code_snapshot, created_at')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 200));
  if (promoId) q = q.eq('promo_code_id', promoId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

module.exports = {
  normalizeCode,
  isOfferCurrentlyValid,
  computeDiscount,
  listPromoCodes,
  getActivePromotionsForSession,
  findPromoByCode,
  applyPromoToSubtotal,
  recordPromoRedemption,
  createPromoCode,
  updatePromoCode,
  listRedemptions,
};
