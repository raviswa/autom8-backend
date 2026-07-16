// src/routes/pos.js
// Handles: menu items, orders, KOT tickets, KDS items, tables, payments, reports
// Extracted from server.js — no logic changes, just moved here.

const express = require('express');
const router  = express.Router();
const { supabaseAdmin }           = require('../config/supabase');
const { invalidateRestaurantConfigCache } = require('../helpers/restaurantConfig');
const { writeAuditLog } = require('../helpers/auditLog');
const {
  authenticateToken,
  getRestaurantId,
  canManageRestaurantSettings,
} = require('../middleware/auth');
const { withAudit, auditOwnerDashboardContext } = require('../middleware/audit');
const { estimateKitchenStartFromTotals, assignScheduledBucket } = require('../helpers/kitchenScheduler');

function requireSettingsAccess(req, res, next) {
  if (!canManageRestaurantSettings(req.user_role))
    return res.status(403).json({ error: 'Unauthorized' });
  if (!req.restaurant_id)
    return res.status(403).json({ error: 'No restaurant outlet linked to this account' });
  next();
}
const { broadcastToRestaurant }   = require('../websocket');
const { sendWhatsAppMessage, sendWhatsAppCatalogMessage } = require('../helpers/whatsapp');
const { applySlotAvailability, getCurrentSlotIST } = require('./catalog');
const { notifyOrderReady }        = require('../helpers/whatsapp');
const { queueFeedbackForTable }   = require('../helpers/feedback');
const {
  resolvePickupLocation,
  parseGoogleMapsCoords,
  resolveFailureMessage,
} = require('../helpers/googleMaps');
const {
  ORDER_SERVICES,
  resolvePaidFeatures,
  mergeEnabledFeatures,
  validateEnabledFeatures,
  enabledOrderServices,
} = require('../helpers/subscriptionFeatures');
const {
  dispatchBookingToKds,
  runDueScheduledJobsForRestaurant,
  reconcileMissedKdsDispatches,
  explainKdsVisibility,
} = require('../helpers/scheduledJobs');
const { formatTokenDisplay } = require('../helpers/portalTokens');

function cartSnapshotToOrderText(cart) {
  if (!cart || typeof cart !== 'object') return '';
  return Object.values(cart)
    .filter((line) => line && typeof line === 'object')
    .map((line) => {
      const qty = line.qty ?? line.quantity ?? 1;
      const name = line.title || line.name || 'Item';
      return `${qty}x ${name}`;
    })
    .filter(Boolean)
    .join(', ');
}

function resolveScheduledOrderText(scheduleMeta, portalMeta) {
  const meta = scheduleMeta && typeof scheduleMeta === 'object' ? scheduleMeta : {};
  const portal = portalMeta && typeof portalMeta === 'object' ? portalMeta : {};
  if (meta.order_text) return meta.order_text;
  if (portal.order_text) return portal.order_text;
  const cart = (meta.cart && Object.keys(meta.cart).length ? meta.cart : portal.cart) || {};
  return cartSnapshotToOrderText(cart);
}

function estimateKitchenStart(slotAt, serviceType, totalCookMinutes, scheduleMeta, totalPackingMinutes) {
  return estimateKitchenStartFromTotals(slotAt, {
    serviceType,
    totalCookMinutes,
    totalPackingMinutes,
    scheduleMeta,
  });
}

function resolveScheduledKitchenStart(order) {
  const stored = order.kitchen_start_at || order.schedule_meta?.kitchen_start_at;
  if (stored) return new Date(stored);
  const meta = {
    ...(order.schedule_meta || {}),
    cart: order.cart,
    service_type: order.service_type,
    transit_minutes: order.transit_minutes ?? order.schedule_meta?.transit_minutes,
    delivery_travel_minutes: order.schedule_meta?.delivery_travel_minutes,
  };
  return estimateKitchenStart(
    order.scheduled_slot_at,
    order.service_type,
    order.total_cook_minutes,
    meta,
    order.total_packing_minutes,
  );
}

function finalizeScheduledOrder(order, kitchenStart, now = new Date()) {
  const withKitchen = {
    ...order,
    kitchen_start_at: kitchenStart ? kitchenStart.toISOString() : order.kitchen_start_at,
  };
  return {
    ...withKitchen,
    bucket: assignScheduledBucket(withKitchen, now),
  };
}

/** Merge portal token meta + recompute kitchen start for every scheduled order. */
async function enrichScheduledOrdersFromPortal(restaurantId, orders) {
  if (!orders?.length) return orders;

  const bookingIds = new Set(orders.map((o) => o.booking_id));
  const { data: tokens, error } = await supabaseAdmin
    .from('walk_in_tokens')
    .select('id, meta, type')
    .eq('restaurant_id', restaurantId)
    .in('type', ['scheduled_takeaway', 'scheduled_delivery']);

  if (error) {
    console.warn('[kds/scheduled] portal token enrich failed:', error.message);
    return orders.map((order) => finalizeScheduledOrder(
      order,
      resolveScheduledKitchenStart(order),
    ));
  }

  const portalByBooking = new Map();
  const portalByTokenId = new Map();
  for (const token of tokens ?? []) {
    const bid = token.meta?.booking_id;
    if (bid && bookingIds.has(bid)) {
      const prev = portalByBooking.get(bid);
      if (!prev || String(token.id).localeCompare(String(prev.id)) > 0) {
        portalByBooking.set(bid, token);
      }
    }
    if (token.id) {
      portalByTokenId.set(String(token.id).toUpperCase(), token);
    }
  }

  const resolvePortalToken = (order) => {
    const byBooking = portalByBooking.get(order.booking_id);
    if (byBooking) return byBooking;
    const raw = String(order.token_number || '').trim().toUpperCase();
    if (!raw) return null;
    return portalByTokenId.get(raw)
      || portalByTokenId.get(raw.startsWith('T-') ? raw : `T-${raw}`)
      || null;
  };

  return orders.map((order) => {
    const portal = resolvePortalToken(order);
    if (!portal) {
      return finalizeScheduledOrder(order, resolveScheduledKitchenStart(order));
    }
    const portalMeta = portal.meta || {};
    const cart = (order.cart && Object.keys(order.cart).length)
      ? order.cart
      : (portalMeta.cart || {});
    const orderText = resolveScheduledOrderText(
      { order_text: order.order_text, cart },
      portalMeta,
    );
    const tokenNumber = String(order.token_number || '').startsWith('T-')
      ? order.token_number
      : (portal.id || order.token_number);
    const portalType = String(portal.type || '').toLowerCase();
    const serviceType = portalType === 'scheduled_delivery'
      ? 'delivery'
      : portalType === 'scheduled_takeaway'
        ? 'takeaway'
        : order.service_type;
    const scheduleMeta = {
      ...(order.schedule_meta || {}),
      ...portalMeta,
      cart,
      service_type: serviceType,
    };
    const cookMinutes = portalMeta.total_cook_minutes
      ?? scheduleMeta.total_cook_minutes
      ?? order.total_cook_minutes;
    const packingMinutes = portalMeta.total_packing_minutes
      ?? scheduleMeta.total_packing_minutes
      ?? order.total_packing_minutes;
    return {
      ...order,
      token_number: tokenNumber,
      order_text: orderText || order.order_text,
      cart,
      service_type: serviceType,
      schedule_meta: scheduleMeta,
      total_cook_minutes: cookMinutes,
      total_packing_minutes: packingMinutes,
      transit_minutes: scheduleMeta.transit_minutes ?? scheduleMeta.delivery_travel_minutes ?? null,
    };
  }).map((order, _idx, list) => {
    const cartKey = (cart) => {
      if (!cart || !Object.keys(cart).length) return '';
      return Object.keys(cart).sort().map((k) => `${k}:${cart[k]?.qty || 1}`).join('|');
    };
    const maxCookByCart = new Map();
    for (const o of list) {
      const key = cartKey(o.cart);
      if (!key) continue;
      const cook = Number(o.total_cook_minutes) || 0;
      maxCookByCart.set(key, Math.max(maxCookByCart.get(key) || 0, cook));
    }
    const key = cartKey(order.cart);
    const alignedCook = key ? (maxCookByCart.get(key) || order.total_cook_minutes) : order.total_cook_minutes;
    const aligned = {
      ...order,
      total_cook_minutes: alignedCook,
    };
    const kitchenStart = resolveScheduledKitchenStart(aligned);
    return finalizeScheduledOrder(aligned, kitchenStart);
  });
}

// ── Menu items ───────────────────────────────────────────────────────────────

router.get('/menu-items', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { category, ignore_slot } = req.query;
    const isManagerView = ignore_slot === 'true';

    const now        = new Date();
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const istMinutes = (utcMinutes + 330) % (24 * 60);
    const istHour    = Math.floor(istMinutes / 60);
    let currentSlot;
    if      (istHour >= 6  && istHour < 11) currentSlot = 'morning_tiffin';
    else if (istHour >= 11 && istHour < 15) currentSlot = 'lunch';
    else if (istHour >= 15 && istHour < 19) currentSlot = 'evening_snacks';
    else if (istHour >= 19 && istHour < 23) currentSlot = 'dinner_tiffin';
    else                                    currentSlot = null;

    let query = supabaseAdmin.from('menu_items').select('*')
      .eq('restaurant_id', req.restaurant_id)
      .is('archived_at', null)          // ← add this line
      .order('time_slot', { ascending: true })
      .order('name',      { ascending: true });

    if (category) query = query.eq('category', category);

    if (isManagerView) {
      query = query.order('is_stocked', { ascending: false });
    } else {
      query = query.eq('is_available', true);
      if (currentSlot) query = query.or(`time_slot.eq.${currentSlot},time_slot.eq.all`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, count: data.length, items: data, current_slot: currentSlot, ist_hour: istHour });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/menu-items', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner')
      return res.status(403).json({ error: 'Unauthorized' });
    const { name, description, price, category } = req.body;
    const { data, error } = await supabaseAdmin.from('menu_items')
      .insert({ restaurant_id: req.restaurant_id, name, description, price, category, is_available: true })
      .select().single();
    if (error) throw error;
    res.json({ success: true, item: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// ── Orders ───────────────────────────────────────────────────────────────────

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
    for (const item of items) {
      const { data: menuItem } = await supabaseAdmin.from('menu_items')
        .select('price').eq('id', item.menu_item_id).single();
      subtotal += menuItem.price * item.quantity;
      const { data: itemData, error: itemError } = await supabaseAdmin.from('order_items')
        .insert({ order_id: orderData.id, menu_item_id: item.menu_item_id, quantity: item.quantity,
          unit_price: menuItem.price, special_instructions: item.special_instructions })
        .select().single();
      if (itemError) throw itemError;
      orderItems.push(itemData);
      await supabaseAdmin.from('kds_items').insert({
        restaurant_id: req.restaurant_id, order_item_id: itemData.id, status: 'pending',
      });
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

router.get('/kds/feed', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!req.restaurant_id) {
      return res.status(403).json({
        error: 'No outlet linked to this account. Select an outlet or log in with an outlet-specific profile.',
      });
    }
    try {
      await runDueScheduledJobsForRestaurant(req.restaurant_id);
    } catch (dispatchErr) {
      console.warn('[kds/feed] scheduled dispatch (non-fatal):', dispatchErr.message);
    }
    try {
      await reconcileMissedKdsDispatches(req.restaurant_id);
    } catch (reconcileErr) {
      console.warn('[kds/feed] reconcile missed dispatch (non-fatal):', reconcileErr.message);
    }

    const { status = 'pending' } = req.query;
    const statusFilter = status === 'all' ? ['pending', 'in_progress', 'ready'] : [status];
    const { data, error } = await supabaseAdmin.from('kds_items')
      .select(`*, order_item:order_item_id!left(*, menu_item:menu_item_id!left(name, description, prep_time_minutes), order:order_id!left(table:table_id!left(table_number, section), order_number))`)
      .eq('restaurant_id', req.restaurant_id)
      .in('status', statusFilter)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, items: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/kds/dispatch-status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!req.restaurant_id) {
      return res.status(403).json({ error: 'No outlet linked to this account.' });
    }
    const tokenQ = String(req.query.token || '').trim();
    const bookingId = String(req.query.booking_id || '').trim();

    if (!tokenQ && !bookingId) {
      return res.status(400).json({ error: 'Provide token (e.g. T-125 or T-2506-125) or booking_id' });
    }

    let bookingQuery = supabaseAdmin
      .from('bookings')
      .select(`
        id, token_number, kitchen_start_at, scheduled_slot_at, kds_sent_at,
        status, payment_status, service_type, schedule_meta, created_at,
        customer:customer_id(name, phone)
      `)
      .eq('restaurant_id', req.restaurant_id);

    if (bookingId) {
      bookingQuery = bookingQuery.eq('id', bookingId);
    } else {
      const digits = tokenQ.replace(/^T-/i, '');
      const variants = [tokenQ, tokenQ.toUpperCase(), `T-${digits}`];
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata', year: '2-digit', month: '2-digit',
      }).formatToParts(new Date());
      const get = (t) => parts.find((p) => p.type === t)?.value || '';
      const monthKey = `${get('year')}${get('month')}`;
      variants.push(`T-${monthKey}-${digits.padStart(3, '0')}`);
      bookingQuery = bookingQuery.in('token_number', [...new Set(variants)]);
    }

    const { data: bookings, error } = await bookingQuery.order('created_at', { ascending: false }).limit(5);
    if (error) throw error;

    const booking = bookings?.[0] ?? null;
    let kdsItems = [];
    if (booking) {
      const tokenVariants = new Set([
        booking.token_number,
        formatTokenDisplay(booking.token_number),
      ].filter(Boolean));
      const { data: items } = await supabaseAdmin
        .from('kds_items')
        .select('id, status, item_name, created_at, updated_at, token_number')
        .eq('restaurant_id', req.restaurant_id)
        .in('token_number', [...tokenVariants])
        .order('created_at', { ascending: true });
      kdsItems = items ?? [];
    }

    const { data: jobs } = booking
      ? await supabaseAdmin.from('scheduled_jobs')
        .select('id, job_type, status, run_at, last_error')
        .eq('booking_id', booking.id)
        .order('run_at', { ascending: true })
      : { data: [] };

    res.json({
      success: true,
      token_query: tokenQ || null,
      booking: booking ? {
        id: booking.id,
        token_number: booking.token_number,
        token_display: formatTokenDisplay(booking.token_number),
        status: booking.status,
        payment_status: booking.payment_status,
        service_type: booking.service_type,
        kitchen_start_at: booking.kitchen_start_at,
        scheduled_slot_at: booking.scheduled_slot_at,
        kds_sent_at: booking.kds_sent_at,
        order_preview: booking.schedule_meta?.order_text || null,
      } : null,
      related_bookings: (bookings ?? []).length,
      scheduled_jobs: jobs ?? [],
      kds_items: kdsItems,
      visibility: explainKdsVisibility(booking, kdsItems),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function istDateRangeBounds(fromDate, toDate) {
  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDay.test(fromDate) || !isoDay.test(toDate)) {
    throw new Error('from and to must be YYYY-MM-DD (IST calendar dates)');
  }
  if (fromDate > toDate) {
    throw new Error('from must be on or before to');
  }
  return {
    start: new Date(`${fromDate}T00:00:00+05:30`).toISOString(),
    end: new Date(`${toDate}T23:59:59.999+05:30`).toISOString(),
  };
}

router.get('/kds/history', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!req.restaurant_id) {
      return res.status(403).json({
        error: 'No outlet linked to this account. Select an outlet or log in with an outlet-specific profile.',
      });
    }

    const todayIst = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    const fromDate = String(req.query.from || todayIst).slice(0, 10);
    const toDate = String(req.query.to || fromDate).slice(0, 10);
    const { start, end } = istDateRangeBounds(fromDate, toDate);

    const { data, error } = await supabaseAdmin.from('kds_items')
      .select(`*, order_item:order_item_id!left(*, menu_item:menu_item_id!left(name, description, prep_time_minutes), order:order_id!left(table:table_id!left(table_number, section), order_number))`)
      .eq('restaurant_id', req.restaurant_id)
      .in('status', ['ready', 'cancelled'])
      .gte('updated_at', start)
      .lte('updated_at', end)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    res.json({
      success: true,
      items: data ?? [],
      from: fromDate,
      to: toDate,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/kds/scheduled', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!req.restaurant_id) {
      return res.status(403).json({ error: 'No outlet linked to this account.' });
    }
    const restaurantId = req.restaurant_id;
    const now = new Date();

    await runDueScheduledJobsForRestaurant(restaurantId);

    const buildEnrichedScheduled = async () => {
      const { data: bookings, error } = await supabaseAdmin
        .from('bookings')
        .select(`
          id, token_number, booking_datetime, scheduled_slot_at, kitchen_start_at,
          total_cook_minutes, total_packing_minutes, schedule_meta, kds_sent_at,
          status, payment_status, service_type,
          customer:customer_id(name, phone)
        `)
        .eq('restaurant_id', restaurantId)
        .in('service_type', ['takeaway', 'delivery'])
        .in('status', ['pending', 'confirmed'])
        .in('payment_status', ['paid', 'pending'])
        .is('kds_sent_at', null)
        .order('booking_datetime', { ascending: true });

      if (error) throw error;

      const oneHourMs = 60 * 60 * 1000;

      const orders = (bookings ?? [])
        .filter((b) => {
          const slotRaw = b.scheduled_slot_at || b.booking_datetime;
          if (!slotRaw) return false;
          const meta = b.schedule_meta || {};
          const isScheduledPrepay = Boolean(
            b.kitchen_start_at || meta.kitchen_start_at || meta.scheduled_at,
          );
          if (isScheduledPrepay) return true;
          const slotMs = new Date(slotRaw).getTime() - now.getTime();
          return slotMs > oneHourMs;
        })
        .map((b) => {
          const meta = b.schedule_meta || {};
          const slotAt = b.scheduled_slot_at || b.booking_datetime;
          const baseOrder = {
            booking_id: b.id,
            token_number: b.token_number,
            customer_name: b.customer?.name,
            customer_phone: b.customer?.phone,
            scheduled_slot_at: slotAt,
            kitchen_start_at: b.kitchen_start_at,
            total_cook_minutes: b.total_cook_minutes,
            total_packing_minutes: b.total_packing_minutes,
            order_text: resolveScheduledOrderText(meta, null),
            cart: meta.cart || {},
            service_type: b.service_type,
            schedule_meta: meta,
            transit_minutes: meta.transit_minutes ?? meta.delivery_travel_minutes ?? null,
            kds_sent_at: b.kds_sent_at,
            status: b.status,
            payment_status: b.payment_status,
          };
          const kitchenStart = resolveScheduledKitchenStart(baseOrder);
          return finalizeScheduledOrder(baseOrder, kitchenStart, now);
        });

      return (await enrichScheduledOrdersFromPortal(restaurantId, orders))
        .filter((o) => o.bucket !== 'live');
    };

    let enrichedOrders = await buildEnrichedScheduled();

    const present = enrichedOrders.filter((o) => o.bucket === 'present');
    if (present.length) {
      let dispatched = false;
      for (const order of present) {
        // Unpaid "present" rows stay on the orange strip; only paid go Live.
        if (order.payment_status && order.payment_status !== 'paid') continue;
        if (await dispatchBookingToKds(restaurantId, order)) dispatched = true;
      }
      if (dispatched) {
        enrichedOrders = await buildEnrichedScheduled();
      }
    }

    const summary = {};
    for (const o of enrichedOrders.filter((x) => x.bucket === 'future' || x.bucket === 'todays_future')) {
      const day = o.scheduled_slot_at?.slice(0, 10) || 'unknown';
      if (!summary[day]) summary[day] = { orders: 0, covers: 0 };
      summary[day].orders += 1;
      summary[day].covers += 1;
    }

    res.json({ success: true, orders: enrichedOrders, summary, now: now.toISOString() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/kds/:id/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabaseAdmin.from('kds_items')
      .update({ status }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;

    if (status === 'ready') {
      try {
        const { data: kdsItem } = await supabaseAdmin.from('kds_items')
          .select('order_item:order_item_id!left(order_id), token_number, customer_phone, service_type')
          .eq('id', req.params.id).single();

        const orderId = kdsItem?.order_item?.order_id;
        if (orderId) {
          const { data: allItems } = await supabaseAdmin.from('kds_items')
            .select('status, order_item:order_item_id!left(order_id)')
            .eq('restaurant_id', req.restaurant_id);
          const orderItems = (allItems ?? []).filter(i => i.order_item?.order_id === orderId);
          const allReady   = orderItems.length > 0 && orderItems.every(i => i.status === 'ready');
          if (allReady) await notifyOrderReady({ orderId, restaurantId: req.restaurant_id, kdsItem });
        }
      } catch (notifyErr) {
        console.error('[KDS ready notify] Failed:', notifyErr.message);
      }
    }

    res.json({ success: true, item: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Tables ───────────────────────────────────────────────────────────────────

router.get('/tables', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('tables').select('*')
      .eq('restaurant_id', req.restaurant_id).order('table_number', { ascending: true });
    if (error) throw error;
    res.json({ success: true, tables: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/tables/:id/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabaseAdmin.from('tables')
      .update({ status }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;

    if (status === 'available') {
      try {
        const { data: recentToken } = await supabaseAdmin.from('walk_in_tokens')
          .select('phone, name, id as token_number, restaurant_id')
          .eq('table_id', req.params.id).eq('status', 'seated')
          .order('seated_at', { ascending: false }).limit(1).maybeSingle();
        if (recentToken?.phone) {
          await queueFeedbackForTable({
            tableId:       req.params.id,
            customerPhone: recentToken.phone,
            customerName:  recentToken.name,
            tokenId:       recentToken.token_number,
            restaurantId:  recentToken.restaurant_id,
            source:        'table-status-available',
          });
        }
      } catch (feedbackQueueErr) {
        console.error('[table-freed] Failed to queue feedback:', feedbackQueueErr.message);
      }
    }

    res.json({ success: true, table: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/tables', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    const { table_number, capacity = 4, section = null } = req.body;
    if (!table_number) return res.status(400).json({ error: 'table_number is required' });
    const { data, error } = await supabaseAdmin
      .from('tables')
      .insert({ restaurant_id: req.restaurant_id, table_number: parseInt(table_number), capacity: parseInt(capacity), section, status: 'available', is_active: true })
      .select().single();
    if (error) throw error;
    res.status(201).json({ success: true, table: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/tables/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    const { table_number, capacity, section, is_active } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (table_number !== undefined) updates.table_number = parseInt(table_number);
    if (capacity     !== undefined) updates.capacity     = parseInt(capacity);
    if (section      !== undefined) updates.section      = section;
    if (is_active    !== undefined) updates.is_active    = Boolean(is_active);
    const { data, error } = await supabaseAdmin
      .from('tables')
      .update(updates)
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;
    res.json({ success: true, table: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/tables/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    // Block delete if table is currently occupied
    const { data: table } = await supabaseAdmin
      .from('tables').select('status, table_number').eq('id', req.params.id).single();
    if (table?.status === 'occupied')
      return res.status(409).json({ error: `Table ${table.table_number} is currently occupied — free it before deleting` });
    const { error } = await supabaseAdmin
      .from('tables')
      .delete()
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Resolve cloud-kitchen pickup coordinates from Maps link or address ─────────

router.post('/restaurants/resolve-pickup', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {
    const { maps_url, pickup_address, city, state } = req.body;
    const resolved = await resolvePickupLocation({
      mapsUrl: maps_url,
      address: pickup_address,
      city,
      state,
    });
    if (!resolved) {
      return res.status(422).json({
        error: resolveFailureMessage({ maps_url, pickup_address }),
      });
    }
    res.json({ success: true, ...resolved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Owner self-service restaurant update ──────────────────────────────────────
// Used by SettingsPanel tabs: Restaurant, Services, Kitchen, WhatsApp

router.put(
  '/restaurants/me',
  authenticateToken,
  getRestaurantId,
  requireSettingsAccess,
  auditOwnerDashboardContext,
  withAudit('settings.update', 'tenant'),
  async (req, res) => {
  try {
    const ALLOWED = [
      'name','display_name','legal_name','address_line1','address_line2',
      'city','state','postal_code','country',
      'contact_phone','contact_email','website_url','cuisine_type',
      'logo_url','gstin','opening_hours',
      'whatsapp_number','waba_id','manager_phone','meta_catalog_id',
      'timezone','dining_duration_minutes','payment_mode','kitchen_workflow',
      'kot_printer_ip','kot_printer_port','kot_printer_enabled',
      'takeaway_fulfillment_mode','fulfillment_sections',
      'parcel_charge_per_item',
      'takeaway_ready_range','delivery_ready_range',
  'restaurant_type','pickup_address','pickup_latitude','pickup_longitude',
  'google_maps_url',
  'delivery_charge_default','delivery_charge_tiers',
  'min_delivery_order_amount','min_takeaway_order_amount',
  'scheduled_delivery_enabled','scheduled_takeaway_enabled','scheduled_kds_lead_minutes','max_delivery_radius_km',
  'scheduled_slot_max_orders','schedule_buffer_minutes','schedule_rounding_minutes','schedule_early_start_max_minutes',
  'shiprocket_connected','shiprocket_api_key','intra_city_charge','outstation_charge','free_delivery_above',
  'cod_enabled_city','cod_enabled_outstation',
  'subscribed_features', 'enabled_services',
    ];

    // These two fields are owner-governed only — a manager may have general
// settings access (whitelisted above), but must not be able to change the
// business type or grant themselves menu-upload rights via direct API call,
// even though the UI already hides these controls from managers.
const OWNER_ONLY_FIELDS = ['lob_type', 'allow_manager_menu_upload', 'shiprocket_api_key'];
const isOwnerLike = ['owner', 'brand_owner'].includes(req.user_role);
    
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => ALLOWED.includes(k))
    );
    if (req.body.maps_url !== undefined) {
      updates.google_maps_url = req.body.maps_url || null;
    }
    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: 'No valid fields provided' });

    if (!isOwnerLike) {
      for (const key of OWNER_ONLY_FIELDS) delete updates[key];
    }

    // ── Validate service toggles against paid plan ───────────────────────────
    if (updates.subscribed_features !== undefined || updates.enabled_services !== undefined) {
      const { data: sub } = await supabaseAdmin
        .from('tenant_subscriptions')
        .select('features')
        .eq('restaurant_id', req.restaurant_id)
        .maybeSingle();

      const paidFeatures = resolvePaidFeatures(sub);

      let nextEnabled;
      if (updates.enabled_services !== undefined) {
        if (!Array.isArray(updates.enabled_services)) {
          return res.status(400).json({ error: 'enabled_services must be an array' });
        }
        const invalidSvc = updates.enabled_services.filter(s => !ORDER_SERVICES.includes(s));
        if (invalidSvc.length) {
          return res.status(400).json({ error: `Invalid services: ${invalidSvc.join(', ')}` });
        }
        nextEnabled = mergeEnabledFeatures(updates.enabled_services, paidFeatures);
        delete updates.enabled_services;
      } else {
        nextEnabled = updates.subscribed_features;
      }

      const check = validateEnabledFeatures(nextEnabled, paidFeatures);
      if (!check.ok) return res.status(403).json({ error: check.error });

      updates.subscribed_features = nextEnabled;
    }

    // Auto-resolve pickup coordinates for cloud kitchens when saving address/maps link
    const needsPickupResolve = (
      (updates.restaurant_type === 'cloud_kitchen' || updates.pickup_address !== undefined)
      && (updates.pickup_address || req.body.maps_url)
      && (updates.pickup_latitude === undefined && updates.pickup_longitude === undefined
          || !updates.pickup_latitude || !updates.pickup_longitude)
    );
    if (needsPickupResolve) {
      const { data: current } = await supabaseAdmin
        .from('tenants')
        .select('city, state, pickup_address, restaurant_type')
        .eq('id', req.restaurant_id)
        .maybeSingle();

      const fromUrl = req.body.maps_url ? parseGoogleMapsCoords(req.body.maps_url) : null;
      if (fromUrl) {
        updates.pickup_latitude = fromUrl.lat;
        updates.pickup_longitude = fromUrl.lng;
      } else {
        const resolved = await resolvePickupLocation({
          mapsUrl: req.body.maps_url,
          address: updates.pickup_address || current?.pickup_address,
          city: updates.city || current?.city,
          state: updates.state || current?.state,
        });
        if (resolved) {
          updates.pickup_latitude = resolved.lat;
          updates.pickup_longitude = resolved.lng;
        }
      }
    }

    if (updates.pickup_latitude !== undefined) {
      const lat = parseFloat(updates.pickup_latitude);
      updates.pickup_latitude = Number.isFinite(lat) ? lat : null;
    }
    if (updates.pickup_longitude !== undefined) {
      const lng = parseFloat(updates.pickup_longitude);
      updates.pickup_longitude = Number.isFinite(lng) ? lng : null;
    }

    const pickupWarning = (
      (updates.restaurant_type === 'cloud_kitchen' || updates.pickup_address)
      && !updates.pickup_latitude
      && !updates.pickup_longitude
    ) ? 'Saved, but pickup coordinates are not set — delivery distance may be inaccurate until you resolve the location.'
      : undefined;

    updates.updated_at = new Date().toISOString();
    let { data, error } = await supabaseAdmin
      .from('tenants')
      .update(updates)
      .eq('id', req.restaurant_id)
      .select().single();

    if (error && /kitchen_workflow|kot_printer/i.test(error.message)) {
      const kitchenKeys = ['kitchen_workflow', 'kot_printer_ip', 'kot_printer_port', 'kot_printer_enabled'];
      const stripped = Object.fromEntries(
        Object.entries(updates).filter(([k]) => !kitchenKeys.includes(k))
      );
      const skippedKitchen = Object.keys(updates).filter(k => kitchenKeys.includes(k));
      if (Object.keys(stripped).length > 1) {
        ({ data, error } = await supabaseAdmin
          .from('tenants')
          .update(stripped)
          .eq('id', req.restaurant_id)
          .select().single());
      }
      if (!error) {
        return res.json({
          success: true,
          restaurant: data,
          warning: skippedKitchen.length
            ? 'Kitchen settings not saved — run migrations/add_restaurant_kitchen_settings.sql in Supabase first.'
            : pickupWarning,
        });
      }
    }
    if (error) throw error;

    invalidateRestaurantConfigCache(req.restaurant_id);

    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: 'Restaurant settings updated', details: { fields: Object.keys(updates) },
    });

    res.json({
      success: true,
      restaurant: data,
      warning: pickupWarning,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── WhatsApp integration credentials ──────────────────────────────────────────
router.get('/restaurants/integration', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('tenant_integrations')
      .select('id,provider,channel,phone_number_id,access_token,webhook_secret,webhook_verify_token,config,is_active')
      .eq('restaurant_id', req.restaurant_id)
      .eq('provider', 'meta').eq('channel', 'whatsapp')
      .maybeSingle();
    res.json({ success: true, integration: data ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/restaurants/integration', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {

    const { provider = 'meta', channel = 'whatsapp', phone_number_id, access_token, webhook_secret, webhook_verify_token } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (phone_number_id     !== undefined) updates.phone_number_id     = phone_number_id;
    if (access_token        !== undefined) updates.access_token        = access_token;
    if (webhook_secret      !== undefined) updates.webhook_secret      = webhook_secret;
    if (webhook_verify_token!== undefined) updates.webhook_verify_token= webhook_verify_token;

    const { data: existing } = await supabaseAdmin
      .from('tenant_integrations')
      .select('id').eq('restaurant_id', req.restaurant_id)
      .eq('provider', provider).eq('channel', channel).maybeSingle();

    let result;
    if (existing) {
      const { data, error } = await supabaseAdmin
        .from('tenant_integrations').update(updates)
        .eq('id', existing.id).select().single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('tenant_integrations')
        .insert({ restaurant_id: req.restaurant_id, provider, channel, is_active: true, ...updates })
        .select().single();
      if (error) throw error;
      result = data;
    }
    invalidateRestaurantConfigCache(req.restaurant_id);
    res.json({ success: true, integration: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Payments ─────────────────────────────────────────────────────────────────

router.post('/payments', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner')
      return res.status(403).json({ error: 'Unauthorized' });

    const { order_id, amount, payment_method } = req.body;
    const { data, error } = await supabaseAdmin.from('payments')
      .insert({ restaurant_id: req.restaurant_id, order_id, amount, payment_method, status: 'completed', processed_by: req.user.sub })
      .select().single();
    if (error) throw error;

    await supabaseAdmin.from('orders').update({ payment_status: 'paid', status: 'completed' }).eq('id', order_id);
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

function istDayBounds(fromStr, toStr) {
  const from = String(fromStr || '').slice(0, 10);
  const to = String(toStr || from).slice(0, 10);
  return {
    from,
    to,
    fromIso: new Date(`${from}T00:00:00+05:30`).toISOString(),
    toIso: new Date(`${to}T23:59:59.999+05:30`).toISOString(),
  };
}

function istDateKey(iso) {
  if (!iso) return 'unknown';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function bookingRevenueTotal(booking) {
  const meta = booking.schedule_meta || {};
  const raw = meta.total ?? meta.totals?.total ?? meta.totals?.grand_total ?? meta.payable_total ?? 0;
  return Number(raw) || 0;
}

router.get('/reports/sales', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });

    const todayKey = istDateKey(new Date().toISOString());
    const { from, to, fromIso, toIso } = istDayBounds(
      req.query.from || req.query.date || todayKey,
      req.query.to || req.query.from || req.query.date || todayKey,
    );

    const [{ data: orders, error: ordersErr }, { data: bookings, error: bookingsErr }] = await Promise.all([
      supabaseAdmin.from('orders')
        .select('id, total_amount, status, created_at, source, order_items(menu_item:menu_item_id(category))')
        .eq('restaurant_id', req.restaurant_id)
        .eq('status', 'completed')
        .gte('created_at', fromIso)
        .lte('created_at', toIso),
      supabaseAdmin.from('bookings')
        .select('id, service_type, payment_status, schedule_meta, created_at, updated_at, token_number')
        .eq('restaurant_id', req.restaurant_id)
        .eq('payment_status', 'paid')
        .gte('updated_at', fromIso)
        .lte('updated_at', toIso),
    ]);

    if (ordersErr) throw ordersErr;
    if (bookingsErr) throw bookingsErr;

    const dineInRevenue = (orders ?? []).reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0);
    const prepayRevenue = (bookings ?? []).reduce((sum, b) => sum + bookingRevenueTotal(b), 0);
    const totalRevenue = dineInRevenue + prepayRevenue;
    const totalOrders = (orders ?? []).length + (bookings ?? []).length;
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    const categoryBreakdown = {};
    (orders ?? []).forEach((order) => {
      order.order_items?.forEach((item) => {
        const cat = item.menu_item?.category || 'Other';
        categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;
      });
    });

    const serviceBreakdown = {
      dine_in: { orders: 0, revenue: 0 },
      takeaway: { orders: 0, revenue: 0 },
      delivery: { orders: 0, revenue: 0 },
      other: { orders: 0, revenue: 0 },
    };
    (orders ?? []).forEach((order) => {
      const st = String(order.service_type || order.source || 'dine_in').toLowerCase();
      const bucket = serviceBreakdown[st] ? st : 'other';
      serviceBreakdown[bucket].orders += 1;
      serviceBreakdown[bucket].revenue += Number(order.total_amount) || 0;
    });
    (bookings ?? []).forEach((booking) => {
      const st = String(booking.service_type || 'other').toLowerCase();
      const bucket = serviceBreakdown[st] ? st : 'other';
      const amt = bookingRevenueTotal(booking);
      serviceBreakdown[bucket].orders += 1;
      serviceBreakdown[bucket].revenue += amt;
    });

    const dailyMap = new Map();
    const bumpDay = (dayKey, revenue, ordersCount) => {
      if (!dailyMap.has(dayKey)) dailyMap.set(dayKey, { date: dayKey, revenue: 0, orders: 0 });
      const row = dailyMap.get(dayKey);
      row.revenue += revenue;
      row.orders += ordersCount;
    };
    (orders ?? []).forEach((o) => bumpDay(istDateKey(o.created_at), Number(o.total_amount) || 0, 1));
    (bookings ?? []).forEach((b) => bumpDay(istDateKey(b.updated_at || b.created_at), bookingRevenueTotal(b), 1));

    const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      success: true,
      report: {
        from,
        to,
        totalOrders,
        totalRevenue,
        avgOrderValue,
        dineInRevenue,
        prepayRevenue,
        categoryBreakdown,
        serviceBreakdown,
        daily,
        completedTableOrders: (orders ?? []).length,
        paidPrepayBookings: (bookings ?? []).length,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
