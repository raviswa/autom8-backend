// Packing-queue WhatsApp nudge (sweets_counter / pre-packed items).
// Dedicated phone only — does NOT fan out to all operational managers.

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { getManagerPhone } = require('./restaurantConfig');
const { validateAndNormalizeWhatsApp } = require('./phoneFormat');
const { sendWhatsAppMessage } = require('./whatsapp');

/**
 * Resolve packing alert phone: sweets_counter_phone → manager_phone → null.
 */
async function getPackingAlertPhone(restaurantId) {
  if (!restaurantId) return null;

  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select('sweets_counter_phone, manager_phone')
    .eq('id', restaurantId)
    .maybeSingle();

  if (error) {
    console.warn(`[packing-alerts] tenant load failed: ${error.message}`);
  }

  const dedicated = data?.sweets_counter_phone;
  if (dedicated) {
    const { value } = validateAndNormalizeWhatsApp(dedicated);
    if (value) return value;
  }

  const manager = data?.manager_phone || (await getManagerPhone(restaurantId));
  if (!manager) return null;
  const { value } = validateAndNormalizeWhatsApp(manager);
  return value || null;
}

/**
 * Short actionable nudge when packing kds_items are created.
 * @param {string} restaurantId
 * @param {{ tokenNumber?: string|null, items?: Array<{ name?: string, qty?: number }> }} opts
 */
async function notifyPackingTicketAlert(restaurantId, opts = {}) {
  const phone = await getPackingAlertPhone(restaurantId);
  if (!phone) {
    console.warn(`[packing-alerts] no phone for restaurant ${restaurantId}`);
    return { sent: false, phone: null };
  }

  const token = opts.tokenNumber || '—';
  const lines = Array.isArray(opts.items) ? opts.items : [];
  const summary = lines.length
    ? lines
      .map((i) => {
        const qty = Math.max(1, parseInt(i.qty || i.quantity || 1, 10));
        const name = i.name || i.item_name || 'Item';
        return qty > 1 ? `${name} ×${qty}` : name;
      })
      .join(', ')
    : 'items';

  const body =
    `🍬 New packing order: Token #${token} — ${summary}. Ready on the packing screen.`;

  try {
    await sendWhatsAppMessage(phone, body, restaurantId);
    return { sent: true, phone };
  } catch (err) {
    console.warn(`[packing-alerts] send failed: ${err.message}`);
    return { sent: false, phone, error: err.message };
  }
}

module.exports = {
  getPackingAlertPhone,
  notifyPackingTicketAlert,
};
