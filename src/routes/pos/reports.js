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
      // bookings has no updated_at in many deployments — use created_at for range + daily buckets.
      supabaseAdmin.from('bookings')
        .select('id, service_type, payment_status, schedule_meta, created_at, token_number')
        .eq('restaurant_id', req.restaurant_id)
        .eq('payment_status', 'paid')
        .gte('created_at', fromIso)
        .lte('created_at', toIso),
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
    (bookings ?? []).forEach((b) => bumpDay(istDateKey(b.created_at), bookingRevenueTotal(b), 1));

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
