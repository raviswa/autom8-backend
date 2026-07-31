'use strict';

/**
 * Low-stock / sold-out manager alerts after inventory deduction.
 * One WhatsApp (ops) + log row per (menu_item, alert_level, IST day).
 */

const { sendOperationalAlerts } = require('./operationalAlerts');

function istDayKey(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * @param {object} supabaseAdmin
 * @param {string} restaurantId
 * @param {Array<{ id, name, next, sold_out, low_stock_alert_units? }>} updates
 */
async function maybeSendStockAlerts(supabaseAdmin, restaurantId, updates) {
  if (!restaurantId || !updates?.length) return { sent: 0 };

  const day = istDayKey();
  let sent = 0;

  for (const u of updates) {
    if (!u?.id) continue;
    const next = Number(u.next);
    if (!Number.isFinite(next)) continue;

    const threshold = Number.isFinite(Number(u.low_stock_alert_units))
      ? Math.max(0, Number(u.low_stock_alert_units))
      : 5;

    let level = null;
    if (next <= 0 || u.sold_out) level = 'sold_out';
    else if (next <= threshold) level = 'low_stock';
    if (!level) continue;

    const { error: insertErr } = await supabaseAdmin
      .from('stock_alert_log')
      .insert({
        tenant_id: restaurantId,
        menu_item_id: u.id,
        alert_level: level,
        day,
      });

    // Unique violation = already alerted today
    if (insertErr) {
      if (/duplicate|unique/i.test(insertErr.message || '')) continue;
      console.warn('[stock-alerts] log insert failed:', insertErr.message);
      continue;
    }

    const label = u.name || 'Item';
    const text = level === 'sold_out'
      ? `Sold out: *${label}* is at 0 units.\nOpen Manager → Menu to Record batch or keep unavailable.`
      : `Low stock: *${label}* has *${next}* unit(s) left (alert at ${threshold}).\nOpen Manager → Menu → Record batch to extend.`;

    try {
      await sendOperationalAlerts(restaurantId, text);
      sent += 1;
    } catch (err) {
      console.warn('[stock-alerts] WhatsApp failed:', err.message);
    }
  }

  return { sent };
}

async function listStockAlertsForDay(supabaseAdmin, restaurantId, day = istDayKey()) {
  const { data, error } = await supabaseAdmin
    .from('stock_alert_log')
    .select('id, menu_item_id, alert_level, day, sent_at, menu_items(id, name, current_stock, retailer_id, is_stocked)')
    .eq('tenant_id', restaurantId)
    .eq('day', day)
    .order('sent_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    menu_item_id: row.menu_item_id,
    alert_level: row.alert_level,
    day: row.day,
    sent_at: row.sent_at,
    name: row.menu_items?.name || 'Item',
    current_stock: row.menu_items?.current_stock,
    retailer_id: row.menu_items?.retailer_id,
    is_stocked: row.menu_items?.is_stocked,
  }));
}

module.exports = {
  maybeSendStockAlerts,
  listStockAlertsForDay,
  istDayKey,
};
