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

router.get('/orders', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    let query = supabaseAdmin.from('orders')
      .select(`*, table:table_id(table_number, section), order_items(*, menu_item:menu_item_id(name, category))`)
      .eq('restaurant_id', req.restaurant_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, orders: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/orders/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('orders')
      .select(`*, table:table_id(table_number, section), order_items(*, menu_item:menu_item_id(name, category, price)), payments(*)`)
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id).single();
    if (error) throw error;
    res.json({ success: true, order: data });
  } catch (err) {
    res.status(404).json({ error: 'Order not found' });
  }
});

router.post('/orders', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner')
      return res.status(403).json({ error: 'Unauthorized' });

    const { table_id, items, notes } = req.body;
    const orderNumber = `ORD-${Date.now()}`;

    const { data: orderData, error: orderError } = await supabaseAdmin.from('orders')
      .insert({ restaurant_id: req.restaurant_id, table_id, order_number: orderNumber, notes, created_by: req.user.sub })
      .select().single();
    if (orderError) throw orderError;

    let subtotal   = 0;
    const orderItems = [];
    const packingAlertItems = [];
    let tenantLobType = null;
    try {
      const { data: tenantRow } = await supabaseAdmin
        .from('tenants')
        .select('lob_type')
        .eq('id', req.restaurant_id)
        .maybeSingle();
      tenantLobType = tenantRow?.lob_type || null;
    } catch (_) { /* non-fatal */ }

    for (const item of items) {
      const { data: menuItem } = await supabaseAdmin.from('menu_items')
        .select('price, name, kitchen_station').eq('id', item.menu_item_id).single();
      subtotal += menuItem.price * item.quantity;
      const { data: itemData, error: itemError } = await supabaseAdmin.from('order_items')
        .insert({ order_id: orderData.id, menu_item_id: item.menu_item_id, quantity: item.quantity,
          unit_price: menuItem.price, special_instructions: item.special_instructions })
        .select().single();
      if (itemError) throw itemError;
      orderItems.push(itemData);
      const station = String(menuItem.kitchen_station || 'assembly').toLowerCase();
      const queue = queueForStation(station, tenantLobType);
      await supabaseAdmin.from('kds_items').insert({
        restaurant_id: req.restaurant_id,
        order_item_id: itemData.id,
        status: 'pending',
        item_name: menuItem.name || 'Item',
        kitchen_station: station,
        queue,
      });
      if (queue === 'packing') {
        packingAlertItems.push({ name: menuItem.name || 'Item', qty: item.quantity });
      }
    }

    if (packingAlertItems.length > 0) {
      try {
        await notifyPackingTicketAlert(req.restaurant_id, {
          tokenNumber: orderNumber,
          items: packingAlertItems,
        });
      } catch (packErr) {
        console.warn('[pos/orders] packing alert failed (non-fatal):', packErr.message);
      }
    }

    const tax = subtotal * 0.1, total = subtotal + tax;
    await supabaseAdmin.from('orders').update({ subtotal, tax, total_amount: total }).eq('id', orderData.id);
    if (table_id) await supabaseAdmin.from('tables').update({ status: 'occupied' }).eq('id', table_id);

    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id: req.user.sub, restaurant_id: req.restaurant_id,
        action: 'Order created', details: { order_id: orderData.id, order_number: orderNumber },
      });
    } catch (_) {}

    res.json({ success: true, order: { ...orderData, subtotal, tax, total_amount: total, order_items: orderItems } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/orders/:id/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabaseAdmin.from('orders')
      .update({ status }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;
    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id: req.user.sub, restaurant_id: req.restaurant_id,
        action: 'Order status updated', details: { order_id: req.params.id, status },
      });
    } catch (_) {}
    res.json({ success: true, order: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/orders/:id/complete', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const orderId = req.params.id;

    const { data: order, error: orderFetchError } = await supabaseAdmin.from('orders')
      .select(`id, order_number, status, restaurant_id, table:table_id!left(table_number), walk_in_tokens(phone)`)
      .eq('id', orderId).eq('restaurant_id', req.restaurant_id).single();
    if (orderFetchError || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'completed' || order.status === 'cancelled')
      return res.status(400).json({ error: `Order is already ${order.status}` });

    const { data: kdsItems, error: kdsFetchError } = await supabaseAdmin.from('kds_items')
      .select('id, status, order_item:order_item_id!left(order_id), customer_phone, token_number')
      .eq('restaurant_id', req.restaurant_id);
    if (kdsFetchError) throw kdsFetchError;

    const orderKdsItems = (kdsItems ?? []).filter(i => i.order_item?.order_id === orderId);
    if (orderKdsItems.length === 0) return res.status(404).json({ error: 'No KDS items found for this order' });

    const activeItems    = orderKdsItems.filter(i => i.status !== 'cancelled');
    const alreadyAllDone = activeItems.every(i => i.status === 'ready');

    if (!alreadyAllDone) {
      const { error: bulkUpdateError } = await supabaseAdmin.from('kds_items')
        .update({ status: 'ready' })
        .in('id', activeItems.map(i => i.id))
        .eq('restaurant_id', req.restaurant_id);
      if (bulkUpdateError) throw bulkUpdateError;
    }

    const firstKdsItem = orderKdsItems.find(i => i.customer_phone) ?? orderKdsItems[0];
    await notifyOrderReady({ orderId, restaurantId: req.restaurant_id, kdsItem: firstKdsItem });

    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id: req.user.sub, restaurant_id: req.restaurant_id,
        action: 'Order marked ready via /complete',
        details: { order_id: orderId, order_number: order.order_number, kds_items_updated: alreadyAllDone ? 0 : activeItems.length },
      });
    } catch (_) {}

    res.json({ success: true, order_id: orderId, order_number: order.order_number, kds_items_updated: alreadyAllDone ? 0 : activeItems.length });
  } catch (err) {
    console.error('[POST /api/orders/:id/complete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/orders/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner')
      return res.status(403).json({ error: 'Unauthorized' });

    const { data, error } = await supabaseAdmin.from('orders')
      .update({ status: 'cancelled' }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;

    if (data.table_id) {
      const { data: activeOrders } = await supabaseAdmin.from('orders').select('id')
        .eq('table_id', data.table_id).in('status', ['pending', 'confirmed', 'in_progress']);
      if (!activeOrders || activeOrders.length === 0)
        await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', data.table_id);
    }

    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id: req.user.sub, restaurant_id: req.restaurant_id,
        action: 'Order cancelled', details: { order_id: req.params.id },
      });
    } catch (_) {}

    res.json({ success: true, order: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── KDS ──────────────────────────────────────────────────────────────────────

module.exports = router;
