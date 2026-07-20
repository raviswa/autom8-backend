'use strict';

/**
 * Weekly Status / broadcast promo draft from top sellers (no Instagram required).
 */

const { sendWhatsAppMessage } = require('./whatsapp');

async function buildWeeklyPromoDraft(supabaseAdmin, restaurantId, { lookbackDays = 7 } = {}) {
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const { data: restaurant } = await supabaseAdmin
    .from('tenants')
    .select('id, display_name, name, manager_phone, whatsapp_number, weekly_promo_drafts_enabled, lob_type')
    .eq('id', restaurantId)
    .maybeSingle();
  if (!restaurant) throw new Error('Restaurant not found');

  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .gte('created_at', since)
    .neq('status', 'cancelled')
    .limit(800);
  const orderIds = (orders || []).map((o) => o.id);

  let top = [];
  if (orderIds.length) {
    const { fetchOrderRevenueById, extractItemName } = require('./dashboardAnalytics');
    const { orderItems } = await fetchOrderRevenueById(supabaseAdmin, orderIds, { restaurantId });
    const counts = {};
    for (const row of orderItems) {
      const name = extractItemName(row);
      if (!name) continue;
      counts[name] = (counts[name] || 0) + (Number(row.quantity) || 1);
    }
    top = Object.entries(counts)
      .map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 3);
  }

  const brand = restaurant.display_name || restaurant.name || 'Our kitchen';
  const lines = top.length
    ? top.map((t, i) => `${i + 1}. ${t.name}`).join('\n')
    : '1. This week’s batch favourites\n2. Fresh jars ready to ship';

  const caption =
    `✨ ${brand} — this week’s bestsellers\n\n${lines}\n\n` +
    `Order on WhatsApp or open our shop link.\n` +
    `Homemade · small batch · ships pan-India`;

  return {
    restaurant_id: restaurantId,
    brand,
    top_sellers: top,
    caption,
    lookback_days: lookbackDays,
  };
}

async function runWeeklyPromoDrafts(supabaseAdmin) {
  const { data: tenants, error } = await supabaseAdmin
    .from('tenants')
    .select('id, display_name, manager_phone, whatsapp_number, weekly_promo_drafts_enabled, lob_type')
    .eq('is_active', true)
    .limit(500);
  if (error) throw error;

  let sent = 0;
  let skipped = 0;
  for (const t of tenants || []) {
    if (t.weekly_promo_drafts_enabled === false) {
      skipped += 1;
      continue;
    }
    const lob = String(t.lob_type || '').toLowerCase();
    // Default: packaged / catalog LOBs. Restaurant dine-in skip unless explicitly enabled.
    if (lob === 'restaurant' && t.weekly_promo_drafts_enabled !== true) {
      skipped += 1;
      continue;
    }
    const phone = t.manager_phone || t.whatsapp_number;
    if (!phone) {
      skipped += 1;
      continue;
    }
    try {
      const draft = await buildWeeklyPromoDraft(supabaseAdmin, t.id);
      const msg =
        `📣 *Weekly promo draft* (copy to Status / broadcast)\n\n${draft.caption}\n\n` +
        `_Tip: paste into WhatsApp Status. Instagram optional._`;
      const ok = await sendWhatsAppMessage(phone, msg, t.id);
      if (ok) sent += 1;
      else skipped += 1;
    } catch (err) {
      console.warn('[weekly-promo]', t.id, err.message);
      skipped += 1;
    }
  }
  return { sent, skipped };
}

module.exports = { buildWeeklyPromoDraft, runWeeklyPromoDrafts };
