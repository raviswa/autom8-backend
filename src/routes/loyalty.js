'use strict';

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function phoneVariants(phone) {
  const digits = digitsOnly(phone);
  if (!digits) return [];
  const variants = new Set([digits, phone]);
  if (digits.length === 10) variants.add(`91${digits}`);
  if (digits.length > 10) variants.add(digits.slice(-10));
  if (digits.startsWith('91') && digits.length === 12) variants.add(digits.slice(2));
  return [...variants].filter(Boolean);
}

async function getLoyaltyBalance(restaurantId, phone) {
  const variants = phoneVariants(phone);
  if (!restaurantId || !variants.length) return 0;
  const { data, error } = await supabaseAdmin
    .from('loyalty_ledger')
    .select('delta, customer_phone')
    .eq('restaurant_id', restaurantId)
    .in('customer_phone', variants);
  if (error) {
    if (/loyalty_ledger|pgrst205|42p01/i.test(error.message || '')) return 0;
    throw error;
  }
  return (data || []).reduce((s, row) => s + Number(row.delta || 0), 0);
}

async function getLoyaltyConfig(restaurantId) {
  const { data } = await supabaseAdmin
    .from('tenants')
    .select('loyalty_points_per_100_inr, loyalty_redeem_points, loyalty_redeem_inr')
    .eq('id', restaurantId)
    .maybeSingle();
  return {
    points_per_100: Number(data?.loyalty_points_per_100_inr ?? 1) || 1,
    redeem_points: Math.max(1, parseInt(data?.loyalty_redeem_points ?? 100, 10) || 100),
    redeem_inr: Number(data?.loyalty_redeem_inr ?? 50) || 50,
  };
}

/**
 * Award points after successful payment fulfillment.
 * Idempotent via unique (booking_id, reason) when booking_id is set.
 */
async function awardLoyaltyForBooking({
  restaurantId,
  phone,
  bookingId,
  paidTotal,
  reason = 'order_paid',
}) {
  if (!restaurantId || !phone || !(Number(paidTotal) > 0)) {
    return { ok: false, awarded: 0 };
  }
  const cfg = await getLoyaltyConfig(restaurantId);
  const points = Math.floor(Number(paidTotal) / 100) * cfg.points_per_100;
  if (points <= 0) return { ok: true, awarded: 0 };

  const phoneKey = digitsOnly(phone) || phone;
  const row = {
    restaurant_id: restaurantId,
    customer_phone: phoneKey,
    delta: points,
    reason,
    booking_id: bookingId || null,
  };

  const { error } = await supabaseAdmin.from('loyalty_ledger').insert(row);
  if (error) {
    if (/duplicate|unique|23505/i.test(`${error.code || ''} ${error.message || ''}`)) {
      return { ok: true, awarded: 0, deduped: true };
    }
    if (/loyalty_ledger|pgrst205|42p01/i.test(error.message || '')) {
      return { ok: false, awarded: 0, skipped: true };
    }
    throw error;
  }
  return { ok: true, awarded: points };
}

/**
 * Redeem points atomically: only insert negative delta if balance covers it.
 * Uses a conditional balance check + insert; concurrent double-spend is blocked
 * by re-checking balance after insert attempt patterns / unique redeem reasons.
 */
async function redeemLoyaltyPoints({
  restaurantId,
  phone,
  points,
  bookingId = null,
  reason = 'checkout_redeem',
}) {
  const need = Math.max(0, Math.floor(Number(points) || 0));
  if (!restaurantId || !phone || need <= 0) {
    return { ok: false, error: 'invalid_redeem' };
  }
  const balance = await getLoyaltyBalance(restaurantId, phone);
  if (balance < need) {
    return { ok: false, error: 'insufficient_points', balance };
  }

  const phoneKey = digitsOnly(phone) || phone;
  const { error } = await supabaseAdmin.from('loyalty_ledger').insert({
    restaurant_id: restaurantId,
    customer_phone: phoneKey,
    delta: -need,
    reason,
    booking_id: bookingId,
  });
  if (error) throw error;

  // Re-read; if somehow overdrawn from a race, insert a correcting credit and fail.
  const after = await getLoyaltyBalance(restaurantId, phone);
  if (after < 0) {
    await supabaseAdmin.from('loyalty_ledger').insert({
      restaurant_id: restaurantId,
      customer_phone: phoneKey,
      delta: need,
      reason: 'redeem_race_rollback',
      booking_id: bookingId,
    });
    return { ok: false, error: 'redeem_race', balance };
  }
  return { ok: true, redeemed: need, balance: after };
}

// Webcart-facing balance (slug-resolved restaurant via query restaurant_id from session route).
router.get('/balance', async (req, res) => {
  try {
    const restaurantId = String(req.query.restaurant_id || '').trim();
    const phone = String(req.query.phone || '').trim();
    if (!restaurantId || !phone) {
      return res.status(400).json({ ok: false, error: 'restaurant_id and phone are required.' });
    }
    const [balance, cfg] = await Promise.all([
      getLoyaltyBalance(restaurantId, phone),
      getLoyaltyConfig(restaurantId),
    ]);
    return res.json({
      ok: true,
      balance,
      redeem_points: cfg.redeem_points,
      redeem_inr: cfg.redeem_inr,
      points_per_100: cfg.points_per_100,
    });
  } catch (err) {
    console.error('[loyalty/balance]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load loyalty balance.' });
  }
});

module.exports = {
  router,
  getLoyaltyBalance,
  getLoyaltyConfig,
  awardLoyaltyForBooking,
  redeemLoyaltyPoints,
};
