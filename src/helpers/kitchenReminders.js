// Notify customers who replied REMIND when the kitchen opens (slot or manager override).

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { sendWhatsAppMessage } = require('./whatsapp');
const { currentSlotLabelIST, nextOpenSlotDescriptionIST } = require('../routes/catalog');

async function countAvailableMenuItems(restaurantId) {
  const { count, error } = await supabaseAdmin
    .from('menu_items')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId)
    .eq('is_available', true)
    .eq('is_stocked', true);
  if (error) throw error;
  return count ?? 0;
}

function buildKitchenOpenMessage() {
  const slotLabel = currentSlotLabelIST();
  if (slotLabel) {
    return (
      `We're open now! 🍽️ *${slotLabel}* is being served — ` +
      'reply *Hi* to see the menu and order.'
    );
  }
  const nextSlot = nextOpenSlotDescriptionIST();
  return (
    "We're open now! 🍽️ The kitchen is taking orders — " +
    'reply *Hi* to see the menu and order.' +
    (nextSlot ? ` (${nextSlot} menu is available.)` : '')
  );
}

/**
 * Send REMIND notifications for customers waiting on kitchen open.
 * Clears remind_when_open after each send so scheduled slot jobs cannot double-notify.
 *
 * @param {{ restaurantId?: string }} [opts] — limit to one restaurant (manager toggle)
 * @returns {Promise<number>} messages sent
 */
async function sendKitchenOpenReminders(opts = {}) {
  const { restaurantId } = opts;

  let query = supabaseAdmin
    .from('conversation_states')
    .select('id, restaurant_id, customer_phone, context');

  if (restaurantId) {
    query = query.eq('restaurant_id', restaurantId);
  }

  const { data: rows, error } = await query;
  if (error) {
    console.error('[kitchen-remind] fetch failed:', error.message);
    return 0;
  }

  const message = buildKitchenOpenMessage();
  let sent = 0;

  for (const row of rows ?? []) {
    const ctx = row.context || {};
    if (!ctx.remind_when_open) continue;

    const phone = row.customer_phone;
    const rowRestaurantId = row.restaurant_id;
    if (!phone || !rowRestaurantId) continue;

    try {
      await sendWhatsAppMessage(phone, message, rowRestaurantId);

      const updated = { ...ctx };
      delete updated.remind_when_open;
      updated.closed_kitchen_attempts = 0;

      await supabaseAdmin
        .from('conversation_states')
        .update({
          context: updated,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);

      sent += 1;
      console.log(`[kitchen-remind] Notified ${phone} (${rowRestaurantId})`);
    } catch (e) {
      console.warn(`[kitchen-remind] Failed for ${phone}:`, e.message);
    }
  }
  return sent;
}

/**
 * Fire queued REMIND notifications when kitchen transitions closed → open.
 * Call from manager kitchen-toggle and from scheduled slot rotation.
 */
async function onKitchenOpened(restaurantId, { source = 'unknown' } = {}) {
  if (!restaurantId) return 0;

  const available = await countAvailableMenuItems(restaurantId);
  if (available <= 0) {
    console.log(`[kitchen-remind] Skip ${source}: kitchen still closed for ${restaurantId}`);
    return 0;
  }

  const sent = await sendKitchenOpenReminders({ restaurantId });
  if (sent) {
    console.log(
      `[kitchen-remind] ${source}: sent ${sent} notification(s) for restaurant ${restaurantId}`,
    );
  }
  return sent;
}

module.exports = {
  sendKitchenOpenReminders,
  onKitchenOpened,
  countAvailableMenuItems,
};
