'use strict';

/**
 * Evening settlement summary for food makers — WhatsApp bookkeeping digest.
 */

const { sendWhatsAppMessage } = require('./whatsapp');

function dayBoundsIST(now = new Date()) {
  // Approximate IST day window as UTC+5:30 calendar date
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const startUtc = Date.UTC(y, m, d, 0, 0, 0) - 5.5 * 60 * 60 * 1000;
  const endUtc = startUtc + 24 * 60 * 60 * 1000;
  return { startISO: new Date(startUtc).toISOString(), endISO: new Date(endUtc).toISOString() };
}

function moneyInr(n) {
  return `₹${Math.round(Number(n || 0)).toLocaleString('en-IN')}`;
}

async function computeDailySettlement(supabaseAdmin, restaurantId, { startISO, endISO } = {}) {
  const bounds = startISO && endISO ? { startISO, endISO } : dayBoundsIST();

  const { data: bookings, error } = await supabaseAdmin
    .from('bookings')
    .select('id, order_ref, payment_status, status, meta, created_at')
    .eq('restaurant_id', restaurantId)
    .gte('created_at', bounds.startISO)
    .lt('created_at', bounds.endISO)
    .limit(500);
  if (error) throw error;

  const paid = (bookings || []).filter((b) => {
    const ps = String(b.payment_status || '').toLowerCase();
    return ps === 'paid' || ps === 'captured' || ps === 'success';
  });

  let collected = 0;
  let shipping = 0;
  for (const b of paid) {
    const meta = b.meta || {};
    const sub = meta.web_cart_submission || meta;
    const total = Number(
      sub.total
      || sub.grand_total
      || meta.amount_paid
      || meta.razorpay_amount
      || 0,
    );
    const ship = Number(
      sub.delivery_charge
      || sub.shipping_charge
      || meta.delivery_charge
      || 0,
    );
    collected += total > 0 ? total : 0;
    shipping += ship > 0 ? ship : 0;
  }

  // Fallback: orders table totals if booking meta sparse
  if (!paid.length) {
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('id, total_amount, status, created_at')
      .eq('restaurant_id', restaurantId)
      .gte('created_at', bounds.startISO)
      .lt('created_at', bounds.endISO)
      .neq('status', 'cancelled')
      .limit(500);
    const list = orders || [];
    return {
      order_count: list.length,
      collected: list.reduce((s, o) => s + (Number(o.total_amount) || 0), 0),
      shipping: 0,
      net: list.reduce((s, o) => s + (Number(o.total_amount) || 0), 0),
      ...bounds,
    };
  }

  const net = Math.max(0, collected - shipping);
  return {
    order_count: paid.length,
    collected,
    shipping,
    net,
    ...bounds,
  };
}

function formatSettlementMessage(restaurantName, summary) {
  const name = restaurantName || 'Your store';
  return (
    `*${name} — today's settlement*\n` +
    `${summary.order_count} order${summary.order_count === 1 ? '' : 's'}\n` +
    `${moneyInr(summary.collected)} collected via Razorpay\n` +
    `${moneyInr(summary.shipping)} in shipping passed through\n` +
    `*${moneyInr(summary.net)} net*\n` +
    `_Auto-reconciled by Autom8_`
  );
}

async function sendDailySettlementForRestaurant(supabaseAdmin, restaurant) {
  const summary = await computeDailySettlement(supabaseAdmin, restaurant.id);
  if (summary.order_count === 0 && summary.collected === 0) {
    return { skipped: true, reason: 'no_orders' };
  }
  const phone = restaurant.manager_phone
    || restaurant.whatsapp_number
    || restaurant.contact_phone;
  if (!phone) return { skipped: true, reason: 'no_phone' };

  const msg = formatSettlementMessage(
    restaurant.display_name || restaurant.name,
    summary,
  );
  const ok = await sendWhatsAppMessage(phone, msg, restaurant.id);
  return { ok, summary, phone };
}

async function runDailySettlements(supabaseAdmin) {
  const { data: tenants, error } = await supabaseAdmin
    .from('tenants')
    .select('id, name, display_name, manager_phone, whatsapp_number, contact_phone, lob_type, daily_settlement_enabled')
    .eq('is_active', true)
    .limit(500);
  if (error) throw error;

  let sent = 0;
  let skipped = 0;
  for (const t of tenants || []) {
    // Default on for packaged LOBs; restaurants opt-in via flag when column set
    const lob = String(t.lob_type || '').toLowerCase();
    const packaged = ['food_products', 'retail', 'b2b', 'psl'].includes(lob);
    if (t.daily_settlement_enabled === false) {
      skipped += 1;
      continue;
    }
    if (t.daily_settlement_enabled == null && !packaged) {
      skipped += 1;
      continue;
    }
    try {
      const result = await sendDailySettlementForRestaurant(supabaseAdmin, t);
      if (result.ok) sent += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      console.warn(`[daily-settlement] ${t.id}:`, err.message);
    }
  }
  return { sent, skipped, total: (tenants || []).length };
}

module.exports = {
  dayBoundsIST,
  computeDailySettlement,
  formatSettlementMessage,
  sendDailySettlementForRestaurant,
  runDailySettlements,
};
