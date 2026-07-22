'use strict';

const express = require('express');
const router = express.Router();
const {
  path,
  supabaseAdmin,
  getKdsSecret,
  normalizePincode,
  resolveCourierZone,
  chargeFromRateCard,
  normalizeShippingProvider,
  fetchShiprocketCheapestRate,
  getAffinityForWebcart,
  cartWeightKg,
  resolveCartLineWeights,
  deductStockForLines,
  joinStockWaitlist,
  deriveMenuDiscount,
  ACTIVE_TOKEN_STATUSES,
  DEFAULT_THEME,
  CHAT_SERVICE_URL,
  SHIPPED_LOBS,
  digitsOnly,
  phoneVariants,
  slugify,
  readHostSlug,
  pickSupportPhone,
  requiresShipping,
  parsePincodeFromAddress,
  formatDeliveryAddress,
  buildSubmissionFingerprint,
  buildExpiredPayload,
  resolveRestaurantBySlug,
  isRestaurantLob,
  calculateDelivery,
  resolveCurrentSlot,
  normalizeSlots,
  isActiveWalkInRow,
  menuTokenSoftSession,
  resolveSession,
  deriveStockStatus,
  fetchMenuItems,
  triggerConfirmAndPay,
  SHIPROCKET_STATUS_MAP,
  triggerShipmentNotify,
} = require('./shared');

router.post('/api/webhooks/shiprocket', async (req, res) => {
  try {
    const body = req.body || {};
    const awb = String(body.awb || body.awb_code || '').trim();
    const orderId = String(body.order_id || body.shipment_id || body.channel_order_id || '').trim();
    const statusRaw = String(body.current_status || body.status || '').toLowerCase().replace(/\s+/g, '_');
    const statusLabel = SHIPROCKET_STATUS_MAP[statusRaw] || body.current_status || body.status || 'Updated';

    if (!awb && !orderId) {
      return res.status(400).json({ ok: false, error: 'Missing shipment identifier.' });
    }

    let booking = null;
    if (orderId) {
      const { data: byRef, error: refErr } = await supabaseAdmin
        .from('bookings')
        .select('id, restaurant_id, customer_phone, order_ref, meta')
        .eq('order_ref', orderId)
        .maybeSingle();
      if (refErr) throw refErr;
      booking = byRef;
      if (!booking) {
        const { data: byMeta, error: metaErr } = await supabaseAdmin
          .from('bookings')
          .select('id, restaurant_id, customer_phone, order_ref, meta')
          .filter('meta->>shiprocket_order_id', 'eq', orderId)
          .maybeSingle();
        if (metaErr) throw metaErr;
        booking = byMeta;
      }
    } else {
      const { data: byAwb, error: awbErr } = await supabaseAdmin
        .from('bookings')
        .select('id, restaurant_id, customer_phone, order_ref, meta')
        .filter('meta->>awb', 'eq', awb)
        .maybeSingle();
      if (awbErr) throw awbErr;
      booking = byAwb;
    }
    if (!booking) {
      return res.json({ ok: true, skipped: true, reason: 'booking_not_found' });
    }

    const nextMeta = {
      ...(booking.meta || {}),
      shipment_status: statusRaw,
      awb: awb || booking.meta?.awb || null,
      courier_name: body.courier_name || body.courier || booking.meta?.courier_name || 'Shiprocket',
    };
    await supabaseAdmin.from('bookings').update({ meta: nextMeta }).eq('id', booking.id);

    await triggerShipmentNotify({
      restaurant_id: booking.restaurant_id,
      customer_phone: booking.customer_phone,
      order_ref: booking.order_ref || booking.id,
      courier_name: nextMeta.courier_name,
      awb: nextMeta.awb,
      status: statusLabel,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[webhooks/shiprocket]', err.message);
    return res.status(500).json({ ok: false, error: 'Webhook processing failed.' });
  }
});

module.exports = router;
