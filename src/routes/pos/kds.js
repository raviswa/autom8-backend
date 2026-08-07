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
  resolveScheduledOrderText,
  resolveScheduledKitchenStart,
  finalizeScheduledOrder,
  looksLikeShiprocketJwt,
  sanitizeRestaurantForClient,
  requireSettingsAccess,
  enrichScheduledOrdersFromPortal,
} = require('./shared');

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
    const queueRaw = String(req.query.queue || 'cooking').toLowerCase();
    const queue = queueRaw === 'packing' ? 'packing' : 'cooking';
    const statusFilter = status === 'all' ? ['pending', 'in_progress', 'ready'] : [status];
    const { data, error } = await supabaseAdmin.from('kds_items')
      .select(`*, order_item:order_item_id!left(*, menu_item:menu_item_id!left(name, description, prep_time_minutes, retailer_id, size_label, pack_size_label, weight_grams), order:order_id!left(table:table_id!left(table_number, section), order_number))`)
      .eq('restaurant_id', req.restaurant_id)
      .eq('queue', queue)
      .in('status', statusFilter)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, items: data, queue });
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
    const queueRaw = String(req.query.queue || 'cooking').toLowerCase();
    const queue = queueRaw === 'packing' ? 'packing' : 'cooking';

    const { data, error } = await supabaseAdmin.from('kds_items')
      .select(`*, order_item:order_item_id!left(*, menu_item:menu_item_id!left(name, description, prep_time_minutes, retailer_id, size_label, pack_size_label, weight_grams), order:order_id!left(table:table_id!left(table_number, section), order_number))`)
      .eq('restaurant_id', req.restaurant_id)
      .eq('queue', queue)
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
      queue,
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

    const extras = {
      awaiting_shipment_details: false,
      booking_id: null,
      own_team_mode: null,
      delivery_channel: null,
      customer_notified: false,
    };

    if (status === 'ready') {
      try {
        const { data: kdsItem } = await supabaseAdmin.from('kds_items')
          .select('queue, token_number, customer_phone, service_type, order_item:order_item_id!left(order_id, order:order_id!left(order_number))')
          .eq('id', req.params.id).single();

        const orderId = kdsItem?.order_item?.order_id;
        if (orderId) {
          const { data: allItems } = await supabaseAdmin.from('kds_items')
            .select('status, queue, order_item:order_item_id!left(order_id)')
            .eq('restaurant_id', req.restaurant_id);
          const orderItems = (allItems ?? []).filter(i => i.order_item?.order_id === orderId);
          const allReady = orderItems.length > 0 && orderItems.every(i => i.status === 'ready');

          // Packing queue: when every packing line for this order is ready, create Shiprocket.
          const packingLines = orderItems.filter((i) => i.queue === 'packing');
          const packingAllReady = packingLines.length > 0
            && packingLines.every((i) => i.status === 'ready');
          const packingComplete = packingAllReady || (kdsItem?.queue === 'packing' && allReady);

          if (allReady) {
            const {
              isShippedLob,
              normalizeOwnTeamMode,
              needsShipmentDetailsBeforeNotify,
              shouldCreateShiprocketForMeta,
            } = require('../../helpers/fulfillmentChannels');

            const { data: tenant } = await supabaseAdmin
              .from('tenants')
              .select('lob_type')
              .eq('id', req.restaurant_id)
              .maybeSingle();

            const svc = String(kdsItem?.service_type || '').toLowerCase();
            const isDelivery = svc === 'delivery' || svc.includes('delivery');
            const shippedLob = isShippedLob(tenant?.lob_type);

            let booking = null;
            let meta = {};
            if (shippedLob && isDelivery) {
              const { resolveBookingForPackedOrder } = require('../../helpers/shiprocketShipment');
              booking = await resolveBookingForPackedOrder({
                restaurantId: req.restaurant_id,
                tokenNumber: kdsItem?.token_number,
                customerPhone: kdsItem?.customer_phone,
                orderNumber: kdsItem?.order_item?.order?.order_number,
              });
              meta = booking?.meta || {};
              extras.booking_id = booking?.id || null;
              extras.delivery_channel = meta.delivery_channel || null;
              extras.own_team_mode = meta.own_team_mode != null
                ? normalizeOwnTeamMode(meta.own_team_mode)
                : normalizeOwnTeamMode(null);
            }

            const channel = String(meta.delivery_channel || '').toLowerCase();
            const shiprocketPath = shippedLob && isDelivery && shouldCreateShiprocketForMeta(meta);
            const ownTeamChannel = channel === 'own_team' || channel === 'custom'
              || (!channel && shippedLob && isDelivery && !shiprocketPath);
            const mode = extras.own_team_mode || normalizeOwnTeamMode(meta.own_team_mode);
            const awaitDetails = shippedLob && isDelivery && ownTeamChannel
              && (needsShipmentDetailsBeforeNotify({ ...meta, delivery_channel: channel || 'own_team', own_team_mode: mode })
                // Prompt packing UI for all own_team deliveries so merchant can confirm
                // own_driver vs rider vs parcel before the customer is notified.
                || mode === 'own_driver'
                || !meta.own_team_mode);

            if (awaitDetails && !shiprocketPath) {
              extras.awaiting_shipment_details = true;
              extras.own_team_mode = mode;
              extras.delivery_channel = channel || 'own_team';
              // Mark order ready for ops, but defer customer WhatsApp until shipment details.
              await supabaseAdmin
                .from('orders')
                .update({ status: 'ready' })
                .eq('id', orderId)
                .neq('status', 'ready')
                .neq('status', 'cancelled');
            } else if (shiprocketPath || channel === 'shiprocket') {
              // Defer customer WhatsApp until AWB is assigned (shiprocketShipment).
              extras.delivery_channel = extras.delivery_channel || 'shiprocket';
              await supabaseAdmin
                .from('orders')
                .update({ status: 'ready' })
                .eq('id', orderId)
                .neq('status', 'ready')
                .neq('status', 'cancelled');
            } else {
              await notifyOrderReady({
                orderId,
                restaurantId: req.restaurant_id,
                kdsItem,
                deliveryExtras: {
                  driver_name: meta.driver_name,
                  driver_phone: meta.driver_phone,
                },
              });
              extras.customer_notified = true;
            }
          }

          if (packingComplete) {
            const { maybeCreateShiprocketOnPackingComplete } = require('../../helpers/shiprocketShipment');
            maybeCreateShiprocketOnPackingComplete({
              restaurantId: req.restaurant_id,
              tokenNumber: kdsItem?.token_number,
              customerPhone: kdsItem?.customer_phone,
              orderNumber: kdsItem?.order_item?.order?.order_number,
              serviceType: kdsItem?.service_type,
            }).catch((srErr) => {
              console.error('[KDS] Shiprocket create failed (non-fatal):', srErr.message);
            });
          }
        }
      } catch (notifyErr) {
        console.error('[KDS ready notify] Failed:', notifyErr.message);
      }
    }

    res.json({ success: true, item: data, ...extras });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Tables ───────────────────────────────────────────────────────────────────

module.exports = router;
