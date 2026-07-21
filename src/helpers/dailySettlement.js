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

function isPaidStatus(status) {
  const ps = String(status || '').toLowerCase();
  return ps === 'paid' || ps === 'captured' || ps === 'success';
}

function lineAmount(meta, keys) {
  const m = meta || {};
  const sub = m.web_cart_submission || m;
  for (const key of keys) {
    const val = Number(sub[key] ?? m[key] ?? 0);
    if (val > 0) return val;
  }
  return 0;
}

async function computeDailySettlement(supabaseAdmin, restaurantId, { startISO, endISO } = {}) {
  const bounds = startISO && endISO ? { startISO, endISO } : dayBoundsIST();

  const { data: bookings, error } = await supabaseAdmin
    .from('bookings')
    .select('id, order_ref, payment_status, status, meta, created_at')
    .eq('restaurant_id', restaurantId)
    .gte('created_at', bounds.startISO)
    .lt('created_at', bounds.endISO)
    .neq('status', 'cancelled')
    .limit(500);
  if (error) throw error;

  const rows = bookings || [];

  // Fallback: orders table if this tenant doesn't populate bookings for web-cart orders
  if (!rows.length) {
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('id, total_amount, status, payment_status, created_at')
      .eq('restaurant_id', restaurantId)
      .gte('created_at', bounds.startISO)
      .lt('created_at', bounds.endISO)
      .neq('status', 'cancelled')
      .limit(500);
    const list = orders || [];
    let collectedFb = 0;
    let codPendingFb = 0;
    for (const o of list) {
      const amt = Number(o.total_amount) || 0;
      if (isPaidStatus(o.payment_status)) collectedFb += amt;
      else codPendingFb += amt;
    }
    return {
      order_count: list.length,
      collected: collectedFb,
      cod_pending: codPendingFb,
      shipping: 0,
      net: collectedFb,
      ...bounds,
    };
  }

  let collected = 0;
  let shipping = 0;
  let codPending = 0;
  for (const b of rows) {
    const total = lineAmount(b.meta, ['total', 'grand_total', 'amount_paid', 'razorpay_amount']);
    if (isPaidStatus(b.payment_status)) {
      collected += total;
      shipping += lineAmount(b.meta, ['delivery_charge', 'shipping_charge']);
    } else {
      // Cash-on-delivery / not-yet-paid — still a real order, just not Razorpay money yet.
      codPending += total;
    }
  }

  const net = Math.max(0, collected - shipping);
  return {
    order_count: rows.length,
    collected,
    cod_pending: codPending,
    shipping,
    net,
    ...bounds,
  };
}

function formatSettlementMessage(restaurantName, summary) {
  const name = restaurantName || 'Your store';
  const codPending = Number(summary.cod_pending || 0);
  const lines = [
    `*${name} — today's settlement*`,
    `${summary.order_count} order${summary.order_count === 1 ? '' : 's'}`,
    `${moneyInr(summary.collected)} collected via Razorpay`,
  ];
  if (codPending > 0) {
    lines.push(`${moneyInr(codPending)} COD — to collect on delivery`);
  }
  lines.push(`${moneyInr(summary.shipping)} in shipping passed through`);
  lines.push(`*${moneyInr(summary.net)} net*`);
  lines.push('_Auto-reconciled by Autom8_');
  return lines.join('\n');
}

async function sendDailySettlementForRestaurant(supabaseAdmin, restaurant) {
  const summary = await computeDailySettlement(supabaseAdmin, restaurant.id);
  if (summary.order_count === 0) {
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
