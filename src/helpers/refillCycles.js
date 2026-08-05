'use strict';

/**
 * Create refill_cycles rows after a booking is paid.
 *
 * reminder_due_at = purchased_at + days_to_empty - lead_time - safety_buffer
 * (floored to purchased_at + 1 day if the result would be in the past).
 *
 * Best-effort only — never throws to callers.
 */

const { supabaseAdmin } = require('../config/supabase');

const ELIGIBLE_LOBS = new Set(['food_products', 'retail']);

function parsePositiveDays(raw, fallback = null) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function extractCartLines(booking) {
  const meta = (booking?.meta && typeof booking.meta === 'object') ? booking.meta : {};
  const scheduleMeta = (booking?.schedule_meta && typeof booking.schedule_meta === 'object')
    ? booking.schedule_meta
    : {};
  const web = meta.web_cart_submission || scheduleMeta.web_cart_submission || {};
  const prepay = meta.prepay_fulfillment_payload || scheduleMeta.prepay_fulfillment_payload || {};

  const raw =
    web.items
    || prepay.items
    || meta.items
    || scheduleMeta.items
    || null;

  const lines = [];
  if (Array.isArray(raw)) {
    for (const it of raw) {
      if (!it || typeof it !== 'object') continue;
      const retailerId = String(
        it.retailer_id || it.id || it.menu_item_id || '',
      ).trim();
      if (!retailerId) continue;
      lines.push({
        retailer_id: retailerId,
        menu_item_id: it.menu_item_id || it.uuid || null,
        name: String(it.name || it.title || it.item_name || '').trim() || null,
      });
    }
  } else if (meta.cart && typeof meta.cart === 'object') {
    for (const [key, line] of Object.entries(meta.cart)) {
      if (!line || typeof line !== 'object') continue;
      const retailerId = String(line.retailer_id || key || '').trim();
      if (!retailerId) continue;
      lines.push({
        retailer_id: retailerId,
        menu_item_id: line.menu_item_id || line.id || null,
        name: String(line.name || line.title || '').trim() || null,
      });
    }
  }
  return lines;
}

function computeReminderDueAt(purchasedAt, daysToEmpty, leadDays, bufferDays) {
  const purchasedMs = purchasedAt.getTime();
  const offsetDays = Math.max(0, daysToEmpty) - Math.max(0, leadDays) - Math.max(0, bufferDays);
  let dueMs = purchasedMs + offsetDays * 86400000;
  const floorMs = purchasedMs + 86400000;
  if (dueMs < floorMs) dueMs = floorMs;
  return new Date(dueMs);
}

async function createRefillCyclesForBooking(bookingId) {
  try {
    const id = String(bookingId || '').trim();
    if (!id) return { ok: false, reason: 'missing_booking_id' };

    const { data: booking, error: bookingErr } = await supabaseAdmin
      .from('bookings')
      .select(
        'id, restaurant_id, payment_status, status, customer_phone, meta, schedule_meta, created_at',
      )
      .eq('id', id)
      .maybeSingle();

    if (bookingErr) {
      console.warn('[refillCycles] load booking:', bookingErr.message);
      return { ok: false, reason: bookingErr.message };
    }
    if (!booking?.restaurant_id) return { ok: false, reason: 'booking_not_found' };

    const paymentStatus = String(booking.payment_status || '').toLowerCase();
    const bookingStatus = String(booking.status || '').toLowerCase();
    const paid = paymentStatus === 'paid' || paymentStatus === 'captured'
      || paymentStatus === 'success' || bookingStatus === 'confirmed';
    if (!paid) return { ok: true, skipped: true, reason: 'not_paid' };

    const restaurantId = booking.restaurant_id;
    const { data: tenant, error: tenantErr } = await supabaseAdmin
      .from('tenants')
      .select('id, lob_type, refill_reminders_enabled, refill_lead_time_days, refill_safety_buffer_days')
      .eq('id', restaurantId)
      .maybeSingle();

    if (tenantErr) {
      console.warn('[refillCycles] load tenant:', tenantErr.message);
      return { ok: false, reason: tenantErr.message };
    }

    const lob = String(tenant?.lob_type || '').toLowerCase();
    if (!ELIGIBLE_LOBS.has(lob)) return { ok: true, skipped: true, reason: 'lob_ineligible' };
    if (!tenant?.refill_reminders_enabled) {
      return { ok: true, skipped: true, reason: 'refill_disabled' };
    }

    const phone = String(booking.customer_phone || '').replace(/\D/g, '');
    if (!phone) return { ok: true, skipped: true, reason: 'no_phone' };

    const lines = extractCartLines(booking);
    if (!lines.length) return { ok: true, skipped: true, reason: 'no_lines' };

    const retailerIds = [...new Set(lines.map((l) => l.retailer_id))];
    const menuIds = [...new Set(lines.map((l) => l.menu_item_id).filter(Boolean))];

    const byRetailer = new Map();
    const byId = new Map();
    const mergeMenuRows = (rows) => {
      for (const row of rows || []) {
        if (row.id) byId.set(String(row.id), row);
        if (row.retailer_id) byRetailer.set(String(row.retailer_id), row);
      }
    };

    if (retailerIds.length) {
      const { data, error } = await supabaseAdmin
        .from('menu_items')
        .select('id, retailer_id, name, days_to_empty, is_available')
        .eq('restaurant_id', restaurantId)
        .in('retailer_id', retailerIds);
      if (error) {
        console.warn('[refillCycles] load menu by retailer_id:', error.message);
        return { ok: false, reason: error.message };
      }
      mergeMenuRows(data);
    }
    if (menuIds.length) {
      const { data, error } = await supabaseAdmin
        .from('menu_items')
        .select('id, retailer_id, name, days_to_empty, is_available')
        .eq('restaurant_id', restaurantId)
        .in('id', menuIds);
      if (error) {
        console.warn('[refillCycles] load menu by id:', error.message);
      } else {
        mergeMenuRows(data);
      }
    }

    const lead = parsePositiveDays(tenant.refill_lead_time_days, 7);
    const buffer = parsePositiveDays(tenant.refill_safety_buffer_days, 3);
    const purchasedAt = new Date();
    let created = 0;

    for (const line of lines) {
      const menu = byRetailer.get(line.retailer_id)
        || (line.menu_item_id ? byId.get(String(line.menu_item_id)) : null);
      if (!menu) continue;

      const daysToEmpty = parsePositiveDays(menu.days_to_empty, null);
      if (!daysToEmpty || daysToEmpty <= 0) continue;

      const retailerKey = String(menu.retailer_id || line.retailer_id || '').trim();
      if (!retailerKey) continue;

      // Close prior open cycles for this phone + SKU
      await supabaseAdmin
        .from('refill_cycles')
        .update({
          status: 'reordered',
          updated_at: new Date().toISOString(),
        })
        .eq('restaurant_id', restaurantId)
        .eq('customer_phone', phone)
        .eq('retailer_id', retailerKey)
        .in('status', ['pending', 'snoozed', 'reminded']);

      const reminderDueAt = computeReminderDueAt(purchasedAt, daysToEmpty, lead, buffer);

      const insertRow = {
          restaurant_id: restaurantId,
          menu_item_id: menu.id || null,
          retailer_id: retailerKey,
          item_name: menu.name || line.name || null,
          booking_id: booking.id,
          customer_phone: phone,
          purchased_at: purchasedAt.toISOString(),
          days_to_empty: daysToEmpty,
          reminder_due_at: reminderDueAt.toISOString(),
          status: 'pending',
          reminder_count: 0,
          snooze_until: null,
          last_reminded_at: null,
          updated_at: purchasedAt.toISOString(),
        };

      let { error: insertErr } = await supabaseAdmin
        .from('refill_cycles')
        .insert(insertRow);

      if (insertErr) {
        console.warn('[refillCycles] insert:', insertErr.message);
        continue;
      }
      created += 1;
    }

    return { ok: true, created };
  } catch (err) {
    console.warn('[refillCycles] unexpected:', err.message);
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  createRefillCyclesForBooking,
  computeReminderDueAt,
  ELIGIBLE_LOBS,
};
