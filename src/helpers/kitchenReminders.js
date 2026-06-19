// Notify customers who replied REMIND when the kitchen slot opens.

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { sendWhatsAppMessage } = require('./whatsapp');
const { currentSlotLabelIST } = require('../routes/catalog');

async function sendKitchenOpenReminders() {
  const slotLabel = currentSlotLabelIST();
  if (!slotLabel) return 0;

  const { data: rows, error } = await supabaseAdmin
    .from('conversation_states')
    .select('id, restaurant_id, customer_phone, context');

  if (error) {
    console.error('[kitchen-remind] fetch failed:', error.message);
    return 0;
  }

  let sent = 0;
  for (const row of rows ?? []) {
    const ctx = row.context || {};
    if (!ctx.remind_when_open) continue;

    const phone = row.customer_phone;
    const restaurantId = row.restaurant_id;
    if (!phone || !restaurantId) continue;

    try {
      await sendWhatsAppMessage(
        phone,
        `We're open now! 🍽️ *${slotLabel}* is being served — reply *Hi* to see the menu and order.`,
        restaurantId,
      );

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
      console.log(`[kitchen-remind] Notified ${phone} (${restaurantId})`);
    } catch (e) {
      console.warn(`[kitchen-remind] Failed for ${phone}:`, e.message);
    }
  }
  return sent;
}

module.exports = { sendKitchenOpenReminders };
