// src/helpers/notifyOrderReady.js
const { supabaseAdmin }         = require('../config/supabase');
const { broadcastToRestaurant } = require('../websocket');
const { sendWhatsAppMessage }   = require('../whatsapp');

async function notifyOrderReady({ orderId, restaurantId, kdsItem }) {
  try {
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('orders')
      .update({ status: 'ready' })
      .eq('id', orderId)
      .neq('status', 'ready')
      .neq('status', 'cancelled')
      .select('order_number, table:table_id!left(table_number), walk_in_tokens(phone)')
      .single();

    if (updateErr || !updated) return;

    const phone = updated.walk_in_tokens?.[0]?.phone ?? kdsItem?.customer_phone ?? null;
    if (phone) {
      await sendWhatsAppMessage(
        phone,
        `✅ *Your order is ready!*\n\nOrder: *${updated.order_number}*\n` +
        (updated.table?.table_number ? `Table: *${updated.table.table_number}*\n` : '') +
        `\nYour food will be served shortly. Enjoy! 🍽️`
      );
    }

    broadcastToRestaurant(restaurantId, {
      type:         'ORDER_READY',
      order_id:     orderId,
      order_number: updated.order_number,
      table_number: updated.table?.table_number ?? null,
      timestamp:    new Date().toISOString(),
    });
  } catch (err) {
    console.error('[notifyOrderReady] Error:', err.message);
  }
}

module.exports = { notifyOrderReady };
