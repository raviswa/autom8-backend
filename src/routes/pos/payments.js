'use strict';

const express = require('express');
const router  = express.Router();
const {
  supabaseAdmin,
  invalidateRestaurantConfigCache,
  writeAuditLog,
  authenticateToken,
  getRestaurantId,
  withAudit,
  auditOwnerDashboardContext,
  normalizeShippingProvider,
  normalizeRateCard,
  normalizePincode,
  resolveCourierZone,
  chargeFromRateCard,
  fetchShiprocketCourierOptions,
  broadcastToRestaurant,
  sendWhatsAppMessage,
  sendWhatsAppCatalogMessage,
  notifyOrderReady,
  notifyPackingTicketAlert,
  queueForStation,
  queueFeedbackForTable,
  resolvePickupLocation,
  parseGoogleMapsCoords,
  resolveFailureMessage,
  ORDER_SERVICES,
  resolvePaidFeatures,
  mergeEnabledFeatures,
  validateEnabledFeatures,
  enabledOrderServices,
  dispatchBookingToKds,
  runDueScheduledJobsForRestaurant,
  reconcileMissedKdsDispatches,
  explainKdsVisibility,
  formatTokenDisplay,
  looksLikeShiprocketJwt,
  sanitizeRestaurantForClient,
  requireSettingsAccess,
  enrichScheduledOrdersFromPortal,
} = require('./shared');

router.post('/payments', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner')
      return res.status(403).json({ error: 'Unauthorized' });

    const { order_id, amount, payment_method } = req.body;
    const { data, error } = await supabaseAdmin.from('payments')
      .insert({ restaurant_id: req.restaurant_id, order_id, amount, payment_method, status: 'completed', processed_by: req.user.sub })
      .select().single();
    if (error) throw error;

    await supabaseAdmin.from('orders').update({
      payment_status: 'paid',
      status: 'completed',
      ...(Number(amount) > 0 ? { total_amount: Number(amount) } : {}),
    }).eq('id', order_id);

    // Durable paid-sale ledger (item lines + GST) — all LOBs.
    try {
      const { recordPaidSaleFromOrder } = require('../../helpers/paidSaleLedger');
      const { data: orderRow } = await supabaseAdmin
        .from('orders')
        .select('*, order_items(quantity, unit_price, menu_item_id, menu_item:menu_item_id(id, name, price))')
        .eq('id', order_id)
        .eq('restaurant_id', req.restaurant_id)
        .maybeSingle();
      const { data: tenantRow } = await supabaseAdmin
        .from('tenants')
        .select('id, lob_type, state, postal_code')
        .eq('id', req.restaurant_id)
        .maybeSingle();
      if (orderRow) {
        const items = orderRow.order_items || [];
        if (Number(amount) > 0 && !(Number(orderRow.subtotal) > 0) && !(Number(orderRow.total_amount) > 0)) {
          orderRow.subtotal = Number(amount);
          orderRow.total_amount = Number(amount);
        }
        await recordPaidSaleFromOrder(supabaseAdmin, orderRow, {
          restaurant: tenantRow,
          orderItems: items,
        });
      }
    } catch (ledgerErr) {
      console.warn('[payment-complete] paid_sale ledger failed (non-fatal):', ledgerErr.message);
    }

    const { data: order } = await supabaseAdmin.from('orders').select('table_id').eq('id', order_id).single();
    if (order.table_id) {
      await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', order.table_id);
      try {
        const { data: recentToken } = await supabaseAdmin.from('walk_in_tokens')
          .select('phone, name, id as token_number, restaurant_id')
          .eq('table_id', order.table_id).eq('status', 'seated')
          .order('seated_at', { ascending: false }).limit(1).maybeSingle();
        if (recentToken?.phone) {
          await queueFeedbackForTable({
            tableId:       order.table_id,
            customerPhone: recentToken.phone,
            customerName:  recentToken.name,
            tokenId:       recentToken.token_number,
            restaurantId:  req.restaurant_id,
            source:        'payment-complete',
          });
        }
      } catch (feedbackQueueErr) {
        console.error('[payment-complete] Failed to queue feedback:', feedbackQueueErr.message);
      }
    }

    try {
      await supabaseAdmin.from('audit_logs').insert({ user_id: req.user.sub, restaurant_id: req.restaurant_id, action: 'Payment processed', details: { order_id, amount, method: payment_method } });
    } catch (_) {}

    res.json({ success: true, payment: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Reports ──────────────────────────────────────────────────────────────────

module.exports = router;
