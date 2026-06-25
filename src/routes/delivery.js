// src/routes/delivery.js
// ============================================================================
// Delivery / Rider Tracking Notifications
//
// POST /api/delivery/rider-assigned
//   Receives partner webhooks (Dunzo, Porter, In-House).
//   Dispatches a customer WA tracking message and mirrors to manager.
//   Auth: shared KDS secret (same as kds/notify).
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin }       = require('../config/supabase');
const { sendWhatsAppMessage } = require('../helpers/whatsapp');
const { sendOperationalAlerts } = require('../helpers/operationalAlerts');

const { getKdsSecret } = require('../config/internalSecret');

const PARTNER_META = {
  dunzo:      { emoji: '🟡', label: 'Dunzo'    },
  porter:     { emoji: '🔵', label: 'Porter'   },
  'in-house': { emoji: '🟢', label: 'In-house' },
  inhouse:    { emoji: '🟢', label: 'In-house' },
};

// ── POST /api/delivery/rider-assigned ────────────────────────────────────────

router.post('/rider-assigned', async (req, res) => {
  // Acknowledge immediately — partner webhook must not time out
  res.status(200).json({ received: true });

  try {
    const {
      secret,
      order_id,
      delivery_partner_name,
      rider_name,
      rider_phone,
      tracking_url,
      restaurant_id,
    } = req.body;

    if (secret !== getKdsSecret()) {
      console.warn('[rider-notify] Rejected — bad secret');
      return;
    }
    if (!order_id) { console.warn('[rider-notify] Missing order_id'); return; }

    await sendRiderAssignedNotification({
      orderId:         order_id,
      deliveryPartner: delivery_partner_name,
      riderName:       rider_name,
      riderPhone:      rider_phone,
      trackingUrl:     tracking_url,
      restaurantId:    restaurant_id,
    });

    // Update orders table with rider info
    if (order_id) {
      await supabaseAdmin.from('orders').update({
        delivery_partner:     delivery_partner_name || null,
        rider_name:           rider_name            || null,
        rider_phone:          rider_phone           || null,
        tracking_url:         tracking_url          || null,
        delivery_assigned_at: new Date().toISOString(),
      }).eq('id', order_id);
    }
  } catch (err) {
    console.error('[rider-notify] Webhook handler error:', err.message);
  }
});

// ── sendRiderAssignedNotification ─────────────────────────────────────────────

async function sendRiderAssignedNotification({ orderId, deliveryPartner, riderName, riderPhone, trackingUrl, restaurantId }) {
  try {
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('order_number, customer_phone, walk_in_tokens(phone, name)')
      .eq('id', orderId)
      .maybeSingle();

    const customerPhone = order?.customer_phone ?? order?.walk_in_tokens?.[0]?.phone ?? null;
    if (!customerPhone) { console.warn(`[rider-notify] No customer phone for order ${orderId}`); return; }

    const { data: restaurant } = await supabaseAdmin
      .from('restaurants').select('name').eq('id', restaurantId).maybeSingle();
    const storeName = restaurant?.name ?? 'our restaurant';

    const partnerKey  = String(deliveryPartner || '').toLowerCase().replace(/\s+/g, '-');
    const partnerMeta = PARTNER_META[partnerKey] ?? { emoji: '🛵', label: deliveryPartner || 'our delivery partner' };

    await sendWhatsAppMessage(
      customerPhone,
      `🛵 *Your order is on the way!*\n\n` +
      `Your meal from *${storeName}* has been picked up by *${partnerMeta.emoji} ${partnerMeta.label}*.\n\n` +
      `👤 *Rider:* ${riderName} (${riderPhone})\n` +
      `📍 *Live Tracking:* ${trackingUrl}\n\nGet your plates ready! 🍽️`,
      restaurantId
    );

    console.log(`[rider-notify] ✅ Sent to ${customerPhone} (order ${orderId})`);

    sendOperationalAlerts(
      restaurantId,
      `🛵 *Rider Assigned*\nOrder: *${order?.order_number ?? orderId}*\nPartner: ${partnerMeta.emoji} ${partnerMeta.label}\nRider: ${riderName} (${riderPhone})\nTracking: ${trackingUrl}`,
    ).catch(e => console.error('[rider-notify] Manager mirror failed:', e.message));
  } catch (err) {
    console.error('[rider-notify] Error:', err.message);
  }
}

module.exports = router;
