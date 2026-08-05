// src/routes/dashboard.js
// ============================================================================
// OWNER DASHBOARD ROUTES — drop-in replacement for the broken inline routes
// Mount BEFORE the broken inline definitions in server.js with:
//   app.use('/api/dashboard', require('./src/routes/dashboard'));
// Express uses the first matching route, so this file wins automatically.
// ============================================================================

const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { computeDashboardInsights } = require('../helpers/dashboardAnalytics');
const { fetchPaidCollections } = require('../helpers/paidRevenue');
const { backfillPaidSales } = require('../helpers/backfillPaidSales');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');
const { getKdsSecret } = require('../config/internalSecret');
const { autoLinkDemoWhatsAppIfNeeded } = require('../helpers/linkExistingWaba');

const CHAT_SERVICE_URL = (process.env.CHAT_SERVICE_URL || 'http://localhost:8001').replace(/\/$/, '');

function normPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function requireOutlet(req, res, next) {
  if (!req.restaurant_id)
    return res.status(403).json({ error: 'No restaurant outlet linked to this account' });
  next();
}

const RESTAURANT_SELECT_FULL = [
  'id', 'name', 'display_name', 'logo_url', 'waba_id', 'whatsapp_number', 'manager_phone', 'sweets_counter_phone', 'meta_catalog_id',
  'timezone', 'dining_duration_minutes', 'payment_mode', 'kitchen_workflow',
  'kot_printer_ip', 'kot_printer_port', 'kot_printer_enabled',
  'takeaway_fulfillment_mode', 'fulfillment_sections', 'parcel_charge_per_item',
  'takeaway_ready_range', 'delivery_ready_range', 'kitchen_busy', 'opening_hours',
  'restaurant_type', 'pickup_address', 'pickup_latitude', 'pickup_longitude',
  'google_maps_url',
  'delivery_charge_default', 'delivery_charge_tiers', 'delivery_distance_tiers_enabled',
  'min_delivery_order_amount', 'min_takeaway_order_amount',
  'scheduled_delivery_enabled', 'scheduled_takeaway_enabled', 'scheduled_kds_lead_minutes', 'max_delivery_radius_km',
  'lob_type',
  'business_family', 'business_vertical', 'business_vertical_other',
  'subscribed_features',
  'whatsapp_needs_existing_pin',
  'allow_manager_menu_upload',    //expose allow_manager_menu_upload to the frontend
  'order_ops_mode',
  'shiprocket_connected', 'shiprocket_email', 'shiprocket_api_key', 'intra_city_charge', 'outstation_charge', 'free_delivery_above',
  'cod_enabled_city', 'cod_enabled_outstation',
  'shipping_provider', 'courier_name', 'courier_rate_card',
  'gstin', 'fssai_license', 'sac_code', 'receipt_tagline',
  'packaging_weight_grams',
  'daily_settlement_enabled', 'weekly_promo_drafts_enabled', 'instagram_handle', 'instagram_user_id',
  'refill_reminders_enabled', 'refill_lead_time_days', 'refill_safety_buffer_days',
  'legal_name', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country',
  'contact_phone', 'contact_email', 'website_url', 'cuisine_type',
  'about_enabled', 'about_note', 'inception_date', 'social_links',
].join(', ');

const RESTAURANT_SELECT_BASE = [
  'id', 'name', 'waba_id', 'whatsapp_number', 'display_name', 'manager_phone', 'sweets_counter_phone', 'meta_catalog_id',
  'timezone', 'dining_duration_minutes', 'payment_mode',
  'takeaway_fulfillment_mode', 'fulfillment_sections', 'opening_hours',
  'lob_type',
  'subscribed_features',
  'whatsapp_needs_existing_pin',
  'allow_manager_menu_upload',  //expose allow_manager_menu_upload to the frontend
  'order_ops_mode',
].join(', ');

async function fetchRestaurantRow(restaurantId) {
  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select(RESTAURANT_SELECT_FULL)
    .eq('id', restaurantId)
    .maybeSingle();

  if (!error) {
    return { data: sanitizeRestaurantForClient(data), error: null };
  }

  console.warn('[dashboard] full tenant select failed — falling back to base columns:', error.message);
  const fallback = await supabaseAdmin
    .from('tenants')
    .select(RESTAURANT_SELECT_BASE)
    .eq('id', restaurantId)
    .maybeSingle();
  if (fallback.data) {
    fallback.data.kitchen_workflow = 'Both_KOT_and_KDS';
    fallback.data.kot_printer_enabled = false;
    fallback.data.meta_catalog_id = null;
    fallback.data.parcel_charge_per_item = 0;
    fallback.data.takeaway_ready_range = null;
    fallback.data.delivery_ready_range = null;
    fallback.data.kitchen_busy = false;
    fallback.data.scheduled_delivery_enabled = false;
    fallback.data.scheduled_takeaway_enabled = false;
    fallback.data.max_delivery_radius_km = 0;
    fallback.data.delivery_charge_default = 30;
    fallback.data.delivery_charge_tiers = [];
    fallback.data.delivery_distance_tiers_enabled = false;
    fallback.data.min_delivery_order_amount = 0;
    fallback.data.min_takeaway_order_amount = 0;
    fallback.data.lob_type = fallback.data.lob_type || 'restaurant';
    fallback.data.business_family = fallback.data.business_family || null;
    fallback.data.business_vertical = fallback.data.business_vertical || null;
    fallback.data.business_vertical_other = fallback.data.business_vertical_other || null;
    fallback.data.allow_manager_menu_upload = fallback.data.allow_manager_menu_upload ?? false;
    fallback.data.order_ops_mode = fallback.data.order_ops_mode || 'combined';
  }
  return { data: sanitizeRestaurantForClient(fallback.data), error: fallback.error };
}

/** Never send Shiprocket password (stored in shiprocket_api_key) to the browser. */
function sanitizeRestaurantForClient(row) {
  if (!row) return row;
  const { shiprocket_api_key, ...rest } = row;
  return {
    ...rest,
    shiprocket_has_password: !!String(shiprocket_api_key || '').trim(),
  };
}

// ── GET /api/dashboard/waba ───────────────────────────────────────────────────
router.get('/waba', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    await autoLinkDemoWhatsAppIfNeeded(req.restaurant_id);
    const { data, error } = await fetchRestaurantRow(req.restaurant_id);

    if (error) console.error('[dashboard/waba]', error.message);
    res.json({ success: true, restaurant: data ?? null });
  } catch (err) {
    console.error('[dashboard/waba]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/wa-orders ─────────────────────────────────────────────
// Durable SoT: paid bookings + completed POS orders (NOT invoices — those purge ~3d).
router.get('/wa-orders', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const paid = await fetchPaidCollections(supabaseAdmin, req.restaurant_id, start, end);
    const orders = (paid.rows || []).map((r) => ({
      id: r.id,
      booking_id: r.booking_id || null,
      order_id: r.order_id,
      created_at: r.created_at,
      service_type: r.service_type,
      status: r.status,
      party_size: r.party_size,
      token_number: r.token_number,
      total_amount: r.total_amount,
      amount_match_mode: r.source === 'booking' ? 'paid_booking' : 'completed_order',
      customers: r.customers,
    }));

    let incompleteTokens = 0;
    try {
      const { count } = await supabaseAdmin
        .from('walk_in_tokens')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', req.restaurant_id)
        .gte('arrived_at', start)
        .lte('arrived_at', end);
      incompleteTokens = Math.max(0, (count || 0) - orders.length);
    } catch (_) { /* non-fatal */ }

    console.log(`[dashboard/wa-orders] ${orders.length} paid collections`);
    res.json({
      success: true,
      orders,
      meta: {
        source: 'paid_collections',
        paidCount: orders.length,
        invoicedCount: orders.length, // legacy alias
        totalRevenue: paid.totalRevenue,
        incompleteTokens,
      },
    });
  } catch (err) {
    console.error('[dashboard/wa-orders]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/cancel-stats ──────────────────────────────────────────
router.get('/cancel-stats', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const [cancelRes, totalRes, sessionRes, completedRes, abortedRes] = await Promise.all([
      supabaseAdmin.from('orders').select('total_amount')
        .eq('restaurant_id', req.restaurant_id).eq('status', 'cancelled')
        .gte('created_at', start).lte('created_at', end),
      supabaseAdmin.from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('restaurant_id', req.restaurant_id)
        .gte('created_at', start).lte('created_at', end),
      supabaseAdmin.from('walk_in_tokens')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', req.restaurant_id)
        .gte('arrived_at', start).lte('arrived_at', end),
      supabaseAdmin.from('walk_in_tokens')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', req.restaurant_id)
        .eq('status', 'completed')
        .gte('arrived_at', start).lte('arrived_at', end),
      supabaseAdmin.from('walk_in_tokens')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', req.restaurant_id)
        .eq('status', 'cancelled')
        .gte('arrived_at', start).lte('arrived_at', end),
    ]);

    const orderCancels    = cancelRes.data ?? [];
    const totalOrders     = totalRes.count ?? 0;
    const orderRevLost    = orderCancels.reduce((s, o) => s + (o.total_amount ?? 0), 0);
    const totalSessions   = sessionRes.count ?? 0;
    const sessionsCompleted = completedRes.count ?? 0;
    const sessionsAborted = abortedRes.count ?? 0;

    res.json({
      success:       true,
      orderCancels:  orderCancels.length,
      orderRevLost,
      totalOrders,
      orderRate:     totalOrders > 0 ? Math.round((orderCancels.length / totalOrders) * 100) : 0,
      // WhatsApp session outcomes (walk_in_tokens)
      totalSessions,
      sessionsCompleted,
      sessionsAborted,
      sessionAborts: sessionsAborted,
      sessionAbortRate: totalSessions > 0 ? Math.round((sessionsAborted / totalSessions) * 100) : 0,
      sessionsIdleAbandoned: null,
      sessionsIdleAbandonedSupported: false,
      sessionAbortDefinition: 'explicit_cancel_only',
      // Legacy keys — kept for older clients; now map to corrected semantics
      bookingCancels:  sessionsAborted,
      totalBookings:   totalSessions,
      bookingRate:     totalSessions > 0 ? Math.round((sessionsAborted / totalSessions) * 100) : 0,
    });
  } catch (err) {
    console.error('[dashboard/cancel-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/insights — Owner analytics pack ───────────────────────

router.get('/insights', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const { start, end, preset } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const insights = await computeDashboardInsights(
      supabaseAdmin,
      req.restaurant_id,
      start,
      end,
      preset || '30d',
    );
    res.json({ success: true, ...insights });
  } catch (err) {
    console.error('[dashboard/insights]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/dashboard/paid-sales/backfill ───────────────────────────────────
// One-shot: freeze historical paid bookings/orders into paid_sales + items.
router.post('/paid-sales/backfill', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner', 'admin'].includes(req.user_role)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const days = Math.min(90, Math.max(1, Number(req.body?.days) || 30));
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const result = await backfillPaidSales(supabaseAdmin, req.restaurant_id, {
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      limit: Math.min(1000, Number(req.body?.limit) || 500),
    });
    console.log(`[dashboard/paid-sales/backfill] restaurant=${req.restaurant_id}`, result);
    res.json({ success: true, days, ...result });
  } catch (err) {
    console.error('[dashboard/paid-sales/backfill]', err.message);
    res.status(500).json({ error: err.message });
  }
});

function resolveDashboardRange(query) {
  const range = String(query.range || '30d').toLowerCase();
  const now = new Date();
  let start;
  let end = query.end ? new Date(query.end) : now;
  if (query.start && query.end) {
    start = new Date(query.start);
    end = new Date(query.end);
  } else if (range === '7d') {
    start = new Date(now.getTime() - 7 * 86400000);
  } else if (range === 'custom' && query.start) {
    start = new Date(query.start);
  } else {
    start = new Date(now.getTime() - 30 * 86400000);
  }
  return { start: start.toISOString(), end: end.toISOString(), range };
}

// ── GET /api/dashboard/item-performance ──────────────────────────────────────
router.get('/item-performance', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const { start, end, range } = resolveDashboardRange(req.query);
    const sort = String(req.query.sort || 'revenue').toLowerCase();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const { data: bookings, error: bookErr } = await supabaseAdmin
      .from('bookings')
      .select('id, status, payment_status, created_at, kds_sent_at, updated_at')
      .eq('restaurant_id', req.restaurant_id)
      .gte('created_at', start)
      .lte('created_at', end);
    if (bookErr) throw bookErr;

    const bookingIds = (bookings || []).map((b) => b.id).filter(Boolean);
    const bookingMeta = new Map((bookings || []).map((b) => [b.id, b]));

    let items = [];
    if (bookingIds.length) {
      // Chunk to avoid URL length limits
      const chunks = [];
      for (let i = 0; i < bookingIds.length; i += 200) chunks.push(bookingIds.slice(i, i + 200));
      for (const chunk of chunks) {
        const { data, error } = await supabaseAdmin
          .from('order_items')
          .select('booking_id, menu_item_id, item_name, quantity, unit_price, total_price, name')
          .in('booking_id', chunk);
        if (error) {
          // Fallback column set for older schemas
          const fallback = await supabaseAdmin
            .from('order_items')
            .select('booking_id, menu_item_id, quantity, unit_price')
            .in('booking_id', chunk);
          if (fallback.error) throw error;
          items = items.concat(fallback.data || []);
        } else {
          items = items.concat(data || []);
        }
      }
    }

    const byItem = new Map();
    for (const row of items) {
      const booking = bookingMeta.get(row.booking_id);
      if (!booking) continue;
      const key = String(row.menu_item_id || row.item_name || row.name || 'unknown');
      const entry = byItem.get(key) || {
        menu_item_id: row.menu_item_id || null,
        name: row.item_name || row.name || 'Item',
        order_count: 0,
        unit_qty: 0,
        revenue: 0,
        cancelled_orders: 0,
        ready_samples: 0,
        ready_minutes_sum: 0,
      };
      const qty = Math.max(0, Number(row.quantity || 0));
      const lineRev = Number(row.total_price != null
        ? row.total_price
        : (Number(row.unit_price || 0) * qty));
      entry.order_count += 1;
      entry.unit_qty += qty;
      const cancelled = String(booking.status || '').toLowerCase() === 'cancelled';
      if (cancelled) entry.cancelled_orders += 1;
      else entry.revenue += lineRev;

      if (booking.kds_sent_at && booking.updated_at && !cancelled) {
        const mins = (new Date(booking.updated_at) - new Date(booking.kds_sent_at)) / 60000;
        if (Number.isFinite(mins) && mins >= 0 && mins < 240) {
          entry.ready_samples += 1;
          entry.ready_minutes_sum += mins;
        }
      }
      if (!entry.name || entry.name === 'Item') {
        entry.name = row.item_name || row.name || entry.name;
      }
      byItem.set(key, entry);
    }

    let rows = [...byItem.values()].map((r) => ({
      menu_item_id: r.menu_item_id,
      name: r.name,
      order_count: r.order_count,
      unit_qty: r.unit_qty,
      revenue: Math.round(r.revenue * 100) / 100,
      cancellation_rate: r.order_count
        ? Math.round((r.cancelled_orders / r.order_count) * 1000) / 10
        : 0,
      avg_ready_minutes: r.ready_samples
        ? Math.round((r.ready_minutes_sum / r.ready_samples) * 10) / 10
        : null,
    }));

    const sorters = {
      revenue: (a, b) => b.revenue - a.revenue,
      orders: (a, b) => b.order_count - a.order_count,
      cancellation: (a, b) => b.cancellation_rate - a.cancellation_rate,
      ready: (a, b) => (b.avg_ready_minutes || 0) - (a.avg_ready_minutes || 0),
    };
    rows.sort(sorters[sort] || sorters.revenue);
    const total = rows.length;
    rows = rows.slice(offset, offset + limit);

    res.json({
      success: true,
      range,
      start,
      end,
      sort,
      total,
      offset,
      limit,
      items: rows,
    });
  } catch (err) {
    console.error('[dashboard/item-performance]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/menu-supply-links ─────────────────────────────────────
// Opt-in POS ↔ Supply SKU mappings for this restaurant.
router.get('/menu-supply-links', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('menu_item_supply_sku')
      .select('id, menu_item_id, supply_client_id, supply_sku_id, consumption_ratio, created_at')
      .eq('restaurant_id', req.restaurant_id)
      .order('created_at', { ascending: false });
    if (error) {
      if (/menu_item_supply_sku|42p01|pgrst205/i.test(error.message || '')) {
        return res.json({ success: true, links: [] });
      }
      throw error;
    }
    res.json({ success: true, links: data || [] });
  } catch (err) {
    console.error('[dashboard/menu-supply-links GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/dashboard/menu-supply-links ────────────────────────────────────
router.post('/menu-supply-links', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const {
      menu_item_id,
      supply_client_id,
      supply_sku_id,
      consumption_ratio = 1,
    } = req.body || {};
    if (!menu_item_id || !supply_client_id || !supply_sku_id) {
      return res.status(400).json({
        error: 'menu_item_id, supply_client_id, and supply_sku_id are required',
      });
    }
    const ratio = Number(consumption_ratio);
    if (!(ratio > 0)) {
      return res.status(400).json({ error: 'consumption_ratio must be > 0' });
    }

    // Ensure client is linked to this restaurant (opt-in bridge).
    const { data: client, error: clientErr } = await supabaseAdmin
      .from('supply_clients')
      .select('id, munafe_restaurant_id')
      .eq('id', supply_client_id)
      .maybeSingle();
    if (clientErr) throw clientErr;
    if (!client || String(client.munafe_restaurant_id) !== String(req.restaurant_id)) {
      return res.status(400).json({
        error: 'supply_client_id must belong to a client linked to this restaurant',
      });
    }

    const { data: menuItem, error: menuErr } = await supabaseAdmin
      .from('menu_items')
      .select('id')
      .eq('id', menu_item_id)
      .eq('restaurant_id', req.restaurant_id)
      .maybeSingle();
    if (menuErr) throw menuErr;
    if (!menuItem) return res.status(404).json({ error: 'Menu item not found' });

    const { data: link, error } = await supabaseAdmin
      .from('menu_item_supply_sku')
      .upsert({
        restaurant_id: req.restaurant_id,
        menu_item_id,
        supply_client_id,
        supply_sku_id,
        consumption_ratio: ratio,
      }, { onConflict: 'restaurant_id,menu_item_id,supply_sku_id' })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, link });
  } catch (err) {
    console.error('[dashboard/menu-supply-links POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/dashboard/menu-supply-links/:id ──────────────────────────────
router.delete('/menu-supply-links/:id', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('menu_item_supply_sku')
      .delete()
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('[dashboard/menu-supply-links DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/customer-cohorts ──────────────────────────────────────
router.get('/customer-cohorts', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const { buildCustomerMap, filterSegment, SEGMENT_KEYS } = require('../helpers/marketingCampaign');
    const map = await buildCustomerMap(req.restaurant_id);
    const all = filterSegment(map, 'all');
    const total = all.length || 0;
    const segments = {};
    for (const key of SEGMENT_KEYS) {
      const list = filterSegment(map, key);
      segments[key] = {
        count: list.length,
        percent: total ? Math.round((list.length / total) * 1000) / 10 : 0,
      };
    }

    const returning = all.filter((c) => Number(c.visitCount || c.orderCount || 0) > 1).length;
    const newCustomers = all.filter((c) => Number(c.visitCount || c.orderCount || 0) <= 1).length;
    const repeatRate = total ? Math.round((returning / total) * 1000) / 10 : 0;

    res.json({
      success: true,
      total_customers: total,
      repeat_rate: repeatRate,
      new_customers: newCustomers,
      returning_customers: returning,
      segments,
    });
  } catch (err) {
    console.error('[dashboard/customer-cohorts]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/dashboard/shipment/manual — custom courier mark-as-shipped ─────
router.post('/shipment/manual', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const bookingId = String(req.body?.booking_id || '').trim();
    const courierName = String(req.body?.courier_name || '').trim();
    const trackingUrl = String(req.body?.tracking_url || '').trim();
    const awbLegacy = String(req.body?.awb || '').trim();
    const trackingOrAwb = trackingUrl || awbLegacy;
    const status = String(req.body?.status || 'Shipped').trim() || 'Shipped';

    if (!bookingId || !courierName || !trackingOrAwb) {
      return res.status(400).json({
        error: 'booking_id, courier_name, and tracking_url are required',
      });
    }

    const { data: tenant, error: tenantErr } = await supabaseAdmin
      .from('tenants')
      .select('shipping_provider')
      .eq('id', req.restaurant_id)
      .maybeSingle();
    if (tenantErr) throw tenantErr;
    const { normalizeShippingProvider } = require('../helpers/courierRates');
    if (normalizeShippingProvider(tenant?.shipping_provider) !== 'custom') {
      return res.status(403).json({
        error: 'Manual mark-as-shipped is only available for custom courier merchants.',
      });
    }

    const { data: booking, error: bookingErr } = await supabaseAdmin
      .from('bookings')
      .select('id, restaurant_id, customer_phone, order_ref, meta')
      .eq('restaurant_id', req.restaurant_id)
      .eq('id', bookingId)
      .maybeSingle();
    if (bookingErr) throw bookingErr;
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const nextMeta = {
      ...(booking.meta || {}),
      courier_name: courierName,
      tracking_url: trackingUrl || trackingOrAwb,
      // Keep awb only when explicitly provided; do not invent Shiprocket AWB from tracking link.
      ...(awbLegacy ? { awb: awbLegacy } : {}),
      shipment_status: 'shipped',
      shipment_mode: 'manual',
      shipping_provider: 'custom',
      delivery_channel: (booking.meta || {}).delivery_channel || 'custom',
      shiprocket_last_error: null,
    };
    const { error: updateErr } = await supabaseAdmin
      .from('bookings')
      .update({ meta: nextMeta })
      .eq('id', booking.id);
    if (updateErr) throw updateErr;

    const secret = getKdsSecret();
    const notifyRes = await fetch(`${CHAT_SERVICE_URL}/internal/shipment-notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': secret,
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        restaurant_id: booking.restaurant_id,
        customer_phone: booking.customer_phone,
        order_ref: booking.order_ref || booking.id,
        courier_name: courierName,
        // Chat helper expects `awb`; pass tracking link/number so WhatsApp still shows it.
        awb: trackingOrAwb,
        status,
      }),
    });
    const notifyData = await notifyRes.json().catch(() => ({}));
    if (!notifyRes.ok || !notifyData.ok) {
      return res.status(500).json({ error: notifyData.error || 'WhatsApp notification failed' });
    }

    res.json({ success: true, booking_id: booking.id, meta: nextMeta });
  } catch (err) {
    console.error('[dashboard/shipment/manual]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET pending same-city Shiprocket requests (manager gate) ─────────────────
router.get('/shipment/local-channel/pending', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const { isLocalShiprocketPending, pendingTimedOut } = require('../helpers/fulfillmentChannels');
    const { data, error } = await supabaseAdmin
      .from('bookings')
      .select('id, token_number, order_ref, customer_name, customer_phone, delivery_address, meta, created_at, status')
      .eq('restaurant_id', req.restaurant_id)
      .order('created_at', { ascending: false })
      .limit(80);
    if (error) throw error;

    const pending = [];
    for (const row of data || []) {
      const meta = row.meta || {};
      if (!isLocalShiprocketPending(meta)) continue;
      if (pendingTimedOut(meta)) {
        // Auto-accept timed-out rows so packing can proceed.
        const nextMeta = {
          ...meta,
          delivery_channel: 'shiprocket',
          delivery_channel_status: 'auto_accepted',
          local_shiprocket_pending_at: null,
        };
        await supabaseAdmin.from('bookings').update({ meta: nextMeta }).eq('id', row.id);
        continue;
      }
      pending.push({
        booking_id: row.id,
        token_number: row.token_number,
        order_ref: row.order_ref,
        customer_name: row.customer_name || meta.customer_name || null,
        customer_phone: row.customer_phone,
        delivery_address: row.delivery_address || meta.delivery_address || null,
        requested_at: meta.local_shiprocket_pending_at || row.created_at,
        delivery_charge: meta.web_cart_submission?.delivery_charge
          ?? meta.delivery_charge
          ?? null,
      });
    }
    res.json({ success: true, pending });
  } catch (err) {
    console.error('[dashboard/local-channel/pending]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST approve / reject same-city Shiprocket preference ────────────────────
router.post('/shipment/local-channel/:bookingId', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const bookingId = String(req.params.bookingId || '').trim();
    const action = String(req.body?.action || '').toLowerCase();
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or reject' });
    }

    const { data: booking, error } = await supabaseAdmin
      .from('bookings')
      .select('id, restaurant_id, customer_phone, order_ref, meta, delivery_address')
      .eq('restaurant_id', req.restaurant_id)
      .eq('id', bookingId)
      .maybeSingle();
    if (error) throw error;
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const meta = booking.meta || {};
    if (String(meta.delivery_channel_status || '') !== 'pending_manager') {
      return res.status(400).json({
        error: 'This order is not awaiting courier approval',
        delivery_channel_status: meta.delivery_channel_status || null,
      });
    }

    let patch;
    let notifyText;
    if (action === 'approve') {
      patch = {
        delivery_channel: 'shiprocket',
        delivery_channel_status: 'confirmed',
        local_shiprocket_pending_at: null,
      };
      notifyText =
        `✅ *Courier confirmed*\n\n` +
        `Order *${booking.order_ref || booking.id}* will ship via courier once packed.`;
    } else {
      // Re-quote own-team local charge for honest pricing
      let ownCharge = Number(meta.intra_city_charge_snapshot);
      if (!Number.isFinite(ownCharge)) {
        const { data: tenant } = await supabaseAdmin
          .from('tenants')
          .select('intra_city_charge, delivery_charge_default, postal_code, shiprocket_api_key, shiprocket_email, shipping_provider, packaging_weight_grams, free_delivery_above, courier_rate_card, courier_name, outstation_charge, cod_enabled_city')
          .eq('id', req.restaurant_id)
          .maybeSingle();
        const pin = String(meta.pincode || meta.delivery_pincode || '').replace(/\D/g, '').slice(0, 6);
        const { calculateDelivery } = require('./webcart/shared');
        // calculateDelivery is in webcart/shared — use flat fallback if import path awkward
        ownCharge = Number(tenant?.intra_city_charge ?? tenant?.delivery_charge_default ?? 0) || 0;
        try {
          if (pin && tenant) {
            const quote = await calculateDelivery(tenant, pin, Number(meta.web_cart_submission?.total || 0), {
              delivery_channel: 'own_team',
              items: meta.web_cart_submission?.items || [],
            });
            ownCharge = Number(quote.charge || ownCharge);
          }
        } catch (_) { /* keep flat */ }
      }

      const prevCharge = Number(meta.web_cart_submission?.delivery_charge ?? meta.delivery_charge ?? 0) || 0;
      patch = {
        delivery_channel: 'own_team',
        delivery_channel_requested: meta.delivery_channel_requested || 'shiprocket',
        delivery_channel_status: 'rejected_to_own_team',
        delivery_source: 'intra_city_flat',
        local_shiprocket_pending_at: null,
        delivery_charge: ownCharge,
        delivery_charge_adjusted_from: prevCharge,
      };
      if (meta.web_cart_submission) {
        patch.web_cart_submission = {
          ...meta.web_cart_submission,
          delivery_charge: ownCharge,
          delivery_channel: 'own_team',
          delivery_channel_status: 'rejected_to_own_team',
        };
      }
      const delta = Math.round((ownCharge - prevCharge) * 100) / 100;
      const feeNote = delta === 0
        ? `Delivery fee remains ₹${Math.round(ownCharge)}.`
        : (delta < 0
          ? `Delivery fee updated to ₹${Math.round(ownCharge)} (₹${Math.abs(delta)} less than courier quote).`
          : `Delivery fee updated to ₹${Math.round(ownCharge)} (₹${delta} more than courier quote — settled with the store).`);
      notifyText =
        `🛵 *Store delivery team assigned*\n\n` +
        `Order *${booking.order_ref || booking.id}* will be delivered by our team (same city).\n` +
        feeNote;
    }

    const nextMeta = { ...meta, ...patch };
    await supabaseAdmin.from('bookings').update({ meta: nextMeta }).eq('id', booking.id);

    if (booking.customer_phone) {
      try {
        const { sendWhatsAppMessage } = require('../helpers/whatsapp');
        await sendWhatsAppMessage(booking.customer_phone, notifyText, req.restaurant_id);
      } catch (waErr) {
        console.warn('[dashboard/local-channel] notify failed:', waErr.message);
      }
    }

    res.json({
      success: true,
      booking_id: booking.id,
      action,
      delivery_channel: nextMeta.delivery_channel,
      delivery_channel_status: nextMeta.delivery_channel_status,
      delivery_charge: nextMeta.delivery_charge ?? null,
    });
  } catch (err) {
    console.error('[dashboard/local-channel]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/shipment/:bookingId — packing UI status ────────────────
router.get('/shipment/:bookingId', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const bookingId = String(req.params.bookingId || '').trim();
    const { data: booking, error } = await supabaseAdmin
      .from('bookings')
      .select('id, token_number, order_ref, meta, service_type')
      .eq('restaurant_id', req.restaurant_id)
      .eq('id', bookingId)
      .maybeSingle();
    if (error) throw error;
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const {
      shipmentPayloadFromMeta,
    } = require('../helpers/shiprocketShipment');
    res.json({
      success: true,
      booking_id: booking.id,
      token_number: booking.token_number,
      order_ref: booking.order_ref,
      service_type: booking.service_type,
      shipment: shipmentPayloadFromMeta(booking.meta || {}),
    });
  } catch (err) {
    console.error('[dashboard/shipment/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/shipment/lookup — resolve by token for packing board ───
router.get('/shipment-lookup', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    const orderRef = String(req.query.order_ref || '').trim();
    if (!token && !orderRef) {
      return res.status(400).json({ error: 'token or order_ref is required' });
    }

    const {
      resolveBookingForPackedOrder,
      shipmentPayloadFromMeta,
    } = require('../helpers/shiprocketShipment');

    const booking = await resolveBookingForPackedOrder({
      restaurantId: req.restaurant_id,
      tokenNumber: token || null,
      customerPhone: null,
      orderNumber: orderRef || null,
    });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const { data: restaurant } = await supabaseAdmin
      .from('tenants')
      .select('id, lob_type, shipping_provider, shiprocket_email, shiprocket_api_key, shiprocket_connected, postal_code')
      .eq('id', req.restaurant_id)
      .maybeSingle();

    res.json({
      success: true,
      booking_id: booking.id,
      token_number: booking.token_number,
      order_ref: booking.order_ref,
      service_type: booking.service_type,
      fulfillment_type: booking.meta?.fulfillment_type || null,
      delivery_channel: booking.meta?.delivery_channel || null,
      delivery_channel_status: booking.meta?.delivery_channel_status || null,
      shipment: {
        ...shipmentPayloadFromMeta(booking.meta || {}),
        tracking_url: require('../helpers/orderJourney').trackUrlFromMeta(booking.meta || {}),
      },
      skip_reason: require('../helpers/orderJourney').skipReasonFor({
        meta: booking.meta || {},
        restaurant,
        serviceType: booking.service_type,
      }),
    });
  } catch (err) {
    console.error('[dashboard/shipment-lookup]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/orders/journey — packaged LOB order lifecycle ───────────
router.get('/orders/journey', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const { buildOrderJourney, normalizeOpsMode } = require('../helpers/orderJourney');
    const { data: restaurant } = await supabaseAdmin
      .from('tenants')
      .select('id, lob_type, shipping_provider, shiprocket_email, shiprocket_api_key, shiprocket_connected, postal_code, order_ops_mode')
      .eq('id', req.restaurant_id)
      .maybeSingle();

    const orders = await buildOrderJourney({
      restaurantId: req.restaurant_id,
      restaurant,
    });
    res.json({
      success: true,
      order_ops_mode: normalizeOpsMode(restaurant?.order_ops_mode),
      orders,
    });
  } catch (err) {
    console.error('[dashboard/orders/journey]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/dashboard/shipment/shiprocket/:bookingId — create / retry ───────
router.post('/shipment/shiprocket/:bookingId', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const bookingId = String(req.params.bookingId || '').trim();
    const force = req.body?.force !== false; // retry defaults to force
    const { createOrRetryShiprocketShipment } = require('../helpers/shiprocketShipment');
    const result = await createOrRetryShiprocketShipment({
      restaurantId: req.restaurant_id,
      bookingId,
      force,
    });
    if (!result.ok && !result.skipped) {
      return res.status(400).json({
        success: false,
        error: result.error || result.reason || 'Shiprocket create failed',
        booking_id: result.booking_id || bookingId,
        shipment: result.shipment,
      });
    }
    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error('[dashboard/shipment/shiprocket]', err.message);
    res.status(500).json({ error: err.message });
  }
});

const { buildPackingSlipPdf, buildShippingLabelPdf } = require('../helpers/packingLabels');
const { cartWeightKg, resolveCartLineWeights } = require('../helpers/cartWeight');

/** Display order ref — bookings has no order_ref column; use token / meta / id. */
function resolveBookingOrderRef(booking) {
  const meta = booking?.meta || {};
  return (
    meta.web_cart_submission?.order_ref
    || meta.order_ref
    || booking?.token_number
    || (booking?.id ? String(booking.id) : null)
  );
}

function resolveBookingCustomer(booking) {
  const meta = booking?.meta || {};
  const cust = booking?.customers || booking?.customer || {};
  const submission = meta.web_cart_submission || {};
  return {
    customer_name:
      booking?.customer_name
      || cust.name
      || submission.customer_name
      || meta.customer_name
      || null,
    customer_phone:
      booking?.customer_phone
      || cust.phone
      || submission.customer_phone
      || meta.customer_phone
      || null,
  };
}

async function loadBookingPackPayload(restaurantId, bookingId) {
  // Real bookings columns only — no order_ref / customer_name (those are not on the table).
  let booking = null;
  let bookingErr = null;
  ({ data: booking, error: bookingErr } = await supabaseAdmin
    .from('bookings')
    .select('id, restaurant_id, customer_id, token_number, delivery_address, meta, created_at, customers(name, phone)')
    .eq('restaurant_id', restaurantId)
    .eq('id', bookingId)
    .maybeSingle());
  if (bookingErr && /customers|meta/i.test(bookingErr.message || '')) {
    // Fallback without embed / meta if schema is thinner
    ({ data: booking, error: bookingErr } = await supabaseAdmin
      .from('bookings')
      .select('id, restaurant_id, customer_id, token_number, delivery_address, created_at, schedule_meta')
      .eq('restaurant_id', restaurantId)
      .eq('id', bookingId)
      .maybeSingle());
    if (booking && !booking.meta && booking.schedule_meta) {
      booking.meta = booking.schedule_meta;
    }
  }
  if (bookingErr) throw bookingErr;
  if (!booking) return null;

  // Resolve customer from FK if embed missing
  if (booking.customer_id && !(booking.customers || booking.customer)) {
    const { data: custRow } = await supabaseAdmin
      .from('customers')
      .select('name, phone')
      .eq('id', booking.customer_id)
      .maybeSingle();
    if (custRow) booking.customers = custRow;
  }

  const { data: restaurant } = await supabaseAdmin
    .from('tenants')
    .select('id, name, display_name, contact_phone, whatsapp_number, postal_code, gstin, fssai_license, receipt_tagline, packaging_weight_grams')
    .eq('id', restaurantId)
    .maybeSingle();

  const meta = booking.meta || {};
  const cust = resolveBookingCustomer(booking);
  const orderRef = resolveBookingOrderRef(booking);
  const customerPhone = cust.customer_phone;

  let lines = [];

  // 1) Prefer packing KDS lines for this token (matches packing board).
  const token = String(booking.token_number || '').trim();
  if (token) {
    const tokenVariants = [...new Set([
      token,
      token.toUpperCase(),
      token.replace(/^T-/i, ''),
      `T-${token.replace(/^T-/i, '')}`,
    ].filter(Boolean))];
    const { data: kdsLines } = await supabaseAdmin
      .from('kds_items')
      .select('item_name, name, quantity, queue')
      .eq('restaurant_id', restaurantId)
      .in('token_number', tokenVariants)
      .in('queue', ['packing', 'cooking']);
    const packingFirst = (kdsLines || []).filter((r) => String(r.queue || '') === 'packing');
    const source = packingFirst.length ? packingFirst : (kdsLines || []);
    if (source.length) {
      const merged = new Map();
      for (const r of source) {
        const name = String(r.item_name || r.name || 'Item').trim() || 'Item';
        const qty = Math.max(1, Number(r.quantity) || 1);
        const prev = merged.get(name) || { name, qty: 0, pack: '', weight_grams: 0, price: null };
        prev.qty += qty;
        merged.set(name, prev);
      }
      lines = [...merged.values()];
    }
  }

  // 2) Cart on THIS booking's meta only.
  if (!lines.length) {
    const cart = meta.web_cart_submission?.items
      || meta.cart
      || meta.items
      || [];
    if (Array.isArray(cart) && cart.length) {
      const { data: menuRows } = await supabaseAdmin
        .from('menu_items')
        .select('id, retailer_id, name, weight_grams, pack_size_label, size_label, item_type, meta, price')
        .eq('restaurant_id', restaurantId)
        .is('archived_at', null);
      const weighted = resolveCartLineWeights(cart, menuRows || []);
      const merged = new Map();
      for (const l of weighted) {
        const src = (menuRows || []).find(
          (m) => String(m.id) === String(l.id) || String(m.retailer_id) === String(l.id),
        );
        const name = l.name || src?.name || 'Item';
        const pack = src?.pack_size_label || src?.size_label || '';
        const key = `${name}||${pack}`;
        const qty = Math.max(1, Number(l.qty) || 1);
        const prev = merged.get(key) || {
          name,
          qty: 0,
          pack,
          weight_grams: l.weight_grams || 0,
          price: l.price ?? src?.price,
        };
        prev.qty += qty;
        merged.set(key, prev);
      }
      lines = [...merged.values()];
    }
  }

  // 3) order_items for THIS booking only (never other phone orders).
  if (!lines.length) {
    const { data: oi } = await supabaseAdmin
      .from('order_items')
      .select('quantity, unit_price, menu_item:menu_item_id(name, weight_grams, pack_size_label, size_label)')
      .eq('booking_id', bookingId);
    if (oi?.length) {
      lines = oi.map((r) => ({
        name: r.menu_item?.name || 'Item',
        qty: r.quantity,
        pack: r.menu_item?.pack_size_label || r.menu_item?.size_label || '',
        weight_grams: r.menu_item?.weight_grams || 0,
        price: r.unit_price,
      }));
    }
  }

  const weightKg = cartWeightKg(
    lines.map((l) => ({ qty: l.qty, weight_grams: l.weight_grams })),
    { packagingGrams: restaurant?.packaging_weight_grams || 0 },
  );

  return {
    restaurant: {
      name: restaurant?.display_name || restaurant?.name,
      contact_phone: restaurant?.contact_phone,
      whatsapp_number: restaurant?.whatsapp_number,
      postal_code: restaurant?.postal_code,
      gstin: restaurant?.gstin,
      fssai_license: restaurant?.fssai_license,
      receipt_tagline: restaurant?.receipt_tagline,
    },
    booking: {
      ...booking,
      order_ref: orderRef,
      customer_name: cust.customer_name,
      customer_phone: customerPhone,
      pincode: meta.pincode || null,
    },
    lines,
    packaging_weight_grams: restaurant?.packaging_weight_grams || 0,
    weight_kg: weightKg,
  };
}

// ── GET packing slip PDF ─────────────────────────────────────────────────────
router.get('/packing-slip/:bookingId', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const payload = await loadBookingPackPayload(req.restaurant_id, req.params.bookingId);
    if (!payload) return res.status(404).json({ error: 'Booking not found' });
    const buf = await buildPackingSlipPdf(payload);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="packing-slip-${payload.booking.order_ref || req.params.bookingId}.pdf"`);
    res.send(buf);
  } catch (err) {
    console.error('[dashboard/packing-slip]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/shipping-label/:bookingId', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const payload = await loadBookingPackPayload(req.restaurant_id, req.params.bookingId);
    if (!payload) return res.status(404).json({ error: 'Booking not found' });
    const buf = await buildShippingLabelPdf(payload);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="shipping-label-${payload.booking.order_ref || req.params.bookingId}.pdf"`);
    res.send(buf);
  } catch (err) {
    console.error('[dashboard/shipping-label]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Today's packing slips as a multi-page PDF (one slip per today's packing booking). */
router.get('/packing-slips/today', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const { istTodayYmd } = require('../helpers/istDate');
    const todayIst = istTodayYmd();
    const startIso = new Date(`${todayIst}T00:00:00+05:30`).toISOString();
    const endIso = new Date(`${todayIst}T23:59:59.999+05:30`).toISOString();
    const bookingCols = 'id, token_number, created_at, kds_sent_at';

    const normalizeTokenKey = (raw) => {
      const s = String(raw || '').trim().toUpperCase();
      if (!s) return '';
      // Collapse T-2508-003 / T-003 / #003 / 003 → comparable key
      return s.replace(/^T-/, '').replace(/^#/, '');
    };

    // Primary: distinct packing KDS tokens touched today (matches packing board).
    const [kdsCreated, kdsUpdated] = await Promise.all([
      supabaseAdmin
        .from('kds_items')
        .select('token_number')
        .eq('restaurant_id', req.restaurant_id)
        .eq('queue', 'packing')
        .gte('created_at', startIso)
        .lte('created_at', endIso)
        .limit(300),
      supabaseAdmin
        .from('kds_items')
        .select('token_number')
        .eq('restaurant_id', req.restaurant_id)
        .eq('queue', 'packing')
        .gte('updated_at', startIso)
        .lte('updated_at', endIso)
        .limit(300),
    ]);
    if (kdsCreated.error) throw kdsCreated.error;
    if (kdsUpdated.error) throw kdsUpdated.error;

    const rawTokens = [...new Set(
      [...(kdsCreated.data || []), ...(kdsUpdated.data || [])]
        .map((i) => String(i.token_number || '').trim())
        .filter(Boolean),
    )];

    // Exact KDS token strings only — do not expand to bare digits (over-matches other orders).
    const tokenIds = [...new Set(rawTokens.flatMap((raw) => {
      const upper = raw.toUpperCase();
      const noPrefix = upper.replace(/^T-/i, '');
      return [raw, upper, `T-${noPrefix}`];
    }))];

    const byId = new Map();

    if (tokenIds.length) {
      const { data: byToken, error: tokenBookErr } = await supabaseAdmin
        .from('bookings')
        .select(bookingCols)
        .eq('restaurant_id', req.restaurant_id)
        .in('token_number', tokenIds)
        .order('created_at', { ascending: false })
        .limit(120);
      if (tokenBookErr) throw tokenBookErr;
      for (const b of byToken || []) byId.set(String(b.id), b);

      const { data: portalRows } = await supabaseAdmin
        .from('walk_in_tokens')
        .select('id, meta')
        .eq('restaurant_id', req.restaurant_id)
        .in('id', tokenIds)
        .limit(120);
      const portalBookingIds = [...new Set(
        (portalRows || [])
          .map((r) => r?.meta?.booking_id)
          .filter(Boolean)
          .map(String),
      )];
      if (portalBookingIds.length) {
        const { data: fromPortal, error: portalBookErr } = await supabaseAdmin
          .from('bookings')
          .select(bookingCols)
          .eq('restaurant_id', req.restaurant_id)
          .in('id', portalBookingIds)
          .limit(120);
        if (portalBookErr) throw portalBookErr;
        for (const b of fromPortal || []) byId.set(String(b.id), b);
      }
    }

    // Fallback only when packing board has no tickets today (webcart / pre-KDS).
    if (!byId.size) {
      const { data: byCreated, error: createdErr } = await supabaseAdmin
        .from('bookings')
        .select(bookingCols)
        .eq('restaurant_id', req.restaurant_id)
        .gte('created_at', startIso)
        .lte('created_at', endIso)
        .order('created_at', { ascending: true })
        .limit(80);
      if (createdErr) throw createdErr;
      for (const b of byCreated || []) byId.set(String(b.id), b);

      const { data: byKdsSent, error: kdsSentErr } = await supabaseAdmin
        .from('bookings')
        .select(bookingCols)
        .eq('restaurant_id', req.restaurant_id)
        .gte('kds_sent_at', startIso)
        .lte('kds_sent_at', endIso)
        .order('kds_sent_at', { ascending: true })
        .limit(80);
      if (kdsSentErr && !/kds_sent_at/i.test(kdsSentErr.message || '')) throw kdsSentErr;
      if (!kdsSentErr) {
        for (const b of byKdsSent || []) byId.set(String(b.id), b);
      }
    }

    // One slip per token — keep the newest booking when several share a token key.
    const byTokenKey = new Map();
    for (const b of byId.values()) {
      const key = normalizeTokenKey(b.token_number) || `id:${b.id}`;
      const prev = byTokenKey.get(key);
      if (!prev) {
        byTokenKey.set(key, b);
        continue;
      }
      const prevTs = new Date(prev.kds_sent_at || prev.created_at || 0).getTime();
      const nextTs = new Date(b.kds_sent_at || b.created_at || 0).getTime();
      if (nextTs >= prevTs) byTokenKey.set(key, b);
    }

    const shipped = [...byTokenKey.values()].sort((a, b) => {
      const ta = new Date(a.kds_sent_at || a.created_at || 0).getTime();
      const tb = new Date(b.kds_sent_at || b.created_at || 0).getTime();
      return ta - tb;
    });

    if (!shipped.length) {
      return res.status(404).json({ error: 'No shippable bookings today' });
    }

    const payloads = [];
    const seenOrderKeys = new Set();
    for (const b of shipped) {
      const payload = await loadBookingPackPayload(req.restaurant_id, b.id);
      if (!payload) continue;
      // Extra guard: same display order ref + phone → one page
      const orderKey = [
        String(payload.booking.order_ref || b.token_number || b.id).toUpperCase(),
        String(payload.booking.customer_phone || ''),
      ].join('|');
      if (seenOrderKeys.has(orderKey)) continue;
      seenOrderKeys.add(orderKey);
      payloads.push({ bookingId: b.id, payload });
    }
    if (!payloads.length) {
      return res.status(404).json({ error: 'No shippable bookings today' });
    }

    const doc = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: false });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    for (const { bookingId, payload } of payloads) {
      doc.addPage();
      const r = payload.restaurant;
      doc.fontSize(16).text(r.name || 'Packing slip');
      if (r.fssai_license) doc.fontSize(9).text(`FSSAI ${r.fssai_license}`);
      doc.moveDown(0.4);
      doc.fontSize(11).text(`Order ${payload.booking.order_ref || bookingId}`);
      doc.fontSize(10).text(payload.booking.customer_name || '');
      doc.text(payload.booking.customer_phone || '');
      if (payload.booking.delivery_address || payload.booking.meta?.delivery_address) {
        doc.text(payload.booking.delivery_address || payload.booking.meta.delivery_address, { width: 480 });
      }
      doc.moveDown(0.3);
      for (const line of payload.lines) {
        doc.text(`${line.qty}× ${line.name}${line.pack ? ` (${line.pack})` : ''}`);
      }
      if (payload.booking.meta?.awb || payload.booking.meta?.tracking_url) {
        doc.moveDown(0.3);
        const track = payload.booking.meta.tracking_url || payload.booking.meta.awb;
        doc.text(
          `${payload.booking.meta.courier_name || 'Courier'}`
          + (payload.booking.meta.awb ? ` · AWB ${payload.booking.meta.awb}` : '')
          + (track && track !== payload.booking.meta.awb ? ` · ${track}` : ''),
        );
      }
    }
    doc.end();
    const buf = await done;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="packing-slips-today.pdf"');
    res.send(buf);
  } catch (err) {
    console.error('[dashboard/packing-slips/today]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Maker growth / finance helpers ───────────────────────────────────────────

router.get('/jar-forecast', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const { forecastJarDemand } = require('../helpers/jarForecast');
    const lookbackDays = Math.min(90, Math.max(7, parseInt(req.query.lookback_days, 10) || 30));
    const horizonDays = Math.min(90, Math.max(7, parseInt(req.query.horizon_days, 10) || 30));
    const data = await forecastJarDemand(supabaseAdmin, req.restaurant_id, { lookbackDays, horizonDays });
    res.json({ ok: true, ...data, note: 'Tier-1 finished-jar forecast. Add recipes later for raw-material kg.' });
  } catch (err) {
    console.error('[dashboard/jar-forecast]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/weekly-promo-draft', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const { buildWeeklyPromoDraft } = require('../helpers/weeklyPromo');
    const draft = await buildWeeklyPromoDraft(supabaseAdmin, req.restaurant_id);
    res.json({ ok: true, ...draft });
  } catch (err) {
    console.error('[dashboard/weekly-promo-draft]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/gift-links', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const { createGiftLink } = require('../helpers/giftLinks');
    const row = await createGiftLink(supabaseAdmin, {
      restaurantId: req.restaurant_id,
      bookingId: req.body?.booking_id || null,
      gifterPhone: req.body?.gifter_phone || null,
      recipientPhone: req.body?.recipient_phone || null,
      recipientName: req.body?.recipient_name || null,
      giftMessage: req.body?.gift_message || null,
    });
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({
      ok: true,
      ...row,
      url: `${base}/gift/${row.token}`,
    });
  } catch (err) {
    console.error('[dashboard/gift-links]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/sku-story/:itemId', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const { buildSkuStorySvg } = require('../helpers/skuStory');
    const { deriveMenuDiscount } = require('../helpers/menuDiscount');
    const { data: item, error } = await supabaseAdmin
      .from('menu_items')
      .select('id, name, price, pack_size_label, size_label, image_url, discount_percent, discount_ends_at, is_special_today, is_todays_special, special_note')
      .eq('id', req.params.itemId)
      .eq('restaurant_id', req.restaurant_id)
      .maybeSingle();
    if (error) throw error;
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const { data: restaurant } = await supabaseAdmin
      .from('tenants')
      .select('display_name, name, receipt_tagline')
      .eq('id', req.restaurant_id)
      .maybeSingle();

    const discount = deriveMenuDiscount(item);
    const svg = buildSkuStorySvg({
      brand: restaurant?.display_name || restaurant?.name || 'Kitchen',
      productName: item.name,
      price: discount.discount_active ? discount.effective_price : discount.list_price,
      compareAtPrice: discount.discount_active ? discount.list_price : null,
      packLabel: item.pack_size_label || item.size_label,
      tagline: restaurant?.receipt_tagline || 'Homemade · small batch',
      shopHint: 'Order on WhatsApp · link in bio',
      promoHeadline: discount.discount_active
        ? `${Math.round(discount.discount_percent)}% OFF`
        : ((item.is_special_today || item.is_todays_special) ? "TODAY'S SPECIAL" : null),
      promoSubcopy: item.special_note || null,
      discountPercent: discount.discount_active ? discount.discount_percent : null,
      isSpecial: !!(item.is_special_today || item.is_todays_special),
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Disposition', `inline; filename="story-${item.id}.svg"`);
    res.send(svg);
  } catch (err) {
    console.error('[dashboard/sku-story]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
