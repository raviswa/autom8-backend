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
const { computeDashboardInsights, fetchOrderRevenueById, nearestTokenForOrder } = require('../helpers/dashboardAnalytics');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');
const { getKdsSecret } = require('../config/internalSecret');

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
  'delivery_charge_default', 'delivery_charge_tiers',
  'min_delivery_order_amount', 'min_takeaway_order_amount',
  'scheduled_delivery_enabled', 'scheduled_takeaway_enabled', 'scheduled_kds_lead_minutes', 'max_delivery_radius_km',
  'lob_type',   // ← add this
  'allow_manager_menu_upload',    //expose allow_manager_menu_upload to the frontend
  'shiprocket_connected', 'shiprocket_email', 'shiprocket_api_key', 'intra_city_charge', 'outstation_charge', 'free_delivery_above',
  'cod_enabled_city', 'cod_enabled_outstation',
  'shipping_provider', 'courier_name', 'courier_rate_card',
  'gstin', 'fssai_license', 'sac_code', 'receipt_tagline',
  'packaging_weight_grams',
  'daily_settlement_enabled', 'weekly_promo_drafts_enabled', 'instagram_handle', 'instagram_user_id',
].join(', ');

const RESTAURANT_SELECT_BASE = [
  'id', 'name', 'waba_id', 'whatsapp_number', 'display_name', 'manager_phone', 'sweets_counter_phone', 'meta_catalog_id',
  'timezone', 'dining_duration_minutes', 'payment_mode',
  'takeaway_fulfillment_mode', 'fulfillment_sections', 'opening_hours',
  'lob_type',   // ← add this
  'allow_manager_menu_upload',  //expose allow_manager_menu_upload to the frontend
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

  if (/kitchen_workflow|kot_printer|meta_catalog_id|parcel_charge_per_item|takeaway_ready_range|delivery_ready_range|kitchen_busy|restaurant_type|delivery_charge|scheduled_delivery|scheduled_takeaway|max_delivery_radius|shipping_provider|courier_rate_card|courier_name|fssai_license|sac_code|receipt_tagline|gstin|shiprocket_api_key/i.test(error.message)) {
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
      fallback.data.min_delivery_order_amount = 0;
      fallback.data.min_takeaway_order_amount = 0;
      fallback.data.lob_type = fallback.data.lob_type || 'restaurant';
      fallback.data.allow_manager_menu_upload = fallback.data.allow_manager_menu_upload ?? false;

    }
    return { data: sanitizeRestaurantForClient(fallback.data), error: fallback.error };
  }
  return { data: null, error };
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
    const { data, error } = await fetchRestaurantRow(req.restaurant_id);

    if (error) console.error('[dashboard/waba]', error.message);
    res.json({ success: true, restaurant: data ?? null });
  } catch (err) {
    console.error('[dashboard/waba]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/wa-orders ─────────────────────────────────────────────
// Source: walk_in_tokens (merged DB — no bookings/customers table)
router.get('/wa-orders', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const { data, error } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('id, arrived_at, status, type, pax, name, phone, table_number')
      .eq('restaurant_id', req.restaurant_id)
      .gte('arrived_at', start)
      .lte('arrived_at', end)
      .order('arrived_at', { ascending: false })
      .limit(500);

    if (error) {
      console.error('[dashboard/wa-orders]', error.message);
      return res.status(500).json({ error: error.message });
    }

    const tokens = data ?? [];

    let orderRows = [];
    const primaryOrders = await supabaseAdmin
      .from('orders')
      .select('id, created_at, status, total_amount, customer_phone, token_id')
      .eq('restaurant_id', req.restaurant_id)
      .gte('created_at', start)
      .lte('created_at', end)
      .neq('status', 'cancelled');

    if (!primaryOrders.error) {
      orderRows = primaryOrders.data ?? [];
    } else {
      const fallbackOrders = await supabaseAdmin
        .from('orders')
        .select('id, created_at, status, total_amount, customer_phone')
        .eq('restaurant_id', req.restaurant_id)
        .gte('created_at', start)
        .lte('created_at', end)
        .neq('status', 'cancelled');

      if (fallbackOrders.error) {
        console.error('[dashboard/wa-orders] orders query failed:', fallbackOrders.error.message);
        return res.status(500).json({ error: fallbackOrders.error.message });
      }

      orderRows = (fallbackOrders.data ?? []).map(r => ({ ...r, token_id: null }));
    }

    // Backfill sparse/zero totals from order_items (incl. menu price fallback).
    const zeroAmountIds = orderRows.filter(r => !(Number(r.total_amount) > 0)).map(r => r.id).filter(Boolean);
    if (zeroAmountIds.length) {
      const { orderRevenueById } = await fetchOrderRevenueById(
        supabaseAdmin,
        zeroAmountIds,
        { restaurantId: req.restaurant_id, start, end },
      );
      orderRows = orderRows.map(r => {
        if (Number(r.total_amount) > 0) return r;
        const fromItems = orderRevenueById[r.id];
        return fromItems > 0 ? { ...r, total_amount: fromItems } : r;
      });
    }

    // Prefer exact token_id links. Phone fallback assigns each unmatched order to
    // at most ONE nearest token for that phone — never broadcast a period total
    // onto every visit for the same guest (that produced duplicate ₹ amounts).
    const amountByToken = {};
    const unmatchedOrders = [];

    for (const row of orderRows) {
      const amount = Number(row.total_amount) || 0;
      if (amount <= 0) continue;

      if (row.token_id) {
        amountByToken[row.token_id] = (amountByToken[row.token_id] || 0) + amount;
      } else {
        unmatchedOrders.push(row);
      }
    }

    const phoneAssignedAmount = {};
    for (const row of unmatchedOrders) {
      const amount = Number(row.total_amount) || 0;
      if (amount <= 0) continue;
      const phoneKey = normPhone(row.customer_phone);
      const best = nearestTokenForOrder(row, tokens, { phoneKey: phoneKey || null });
      if (!best) continue;
      phoneAssignedAmount[best.id] = (phoneAssignedAmount[best.id] || 0) + amount;
    }

    const orders = tokens.map(t => {
      const tokenAmount = amountByToken[t.id];
      const phoneAmount = phoneAssignedAmount[t.id];
      const resolvedAmount = tokenAmount != null
        ? tokenAmount
        : (phoneAmount != null ? phoneAmount : 0);

      return {
        id:           t.id,
        created_at:   t.arrived_at,
        service_type: t.type,
        status:       t.status,
        party_size:   t.pax,
        token_number: t.id,
        total_amount: Math.round(resolvedAmount * 100) / 100,
        amount_match_mode: tokenAmount != null
          ? 'token_id_exact'
          : (phoneAmount != null ? 'phone_nearest_token' : 'none'),
        customers:    { name: t.name, phone: t.phone },
      };
    });

    console.log(`[dashboard/wa-orders] ${orders.length} tokens`);
    res.json({ success: true, orders });
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

// ── POST /api/dashboard/shipment/manual — merchant enters courier + AWB ───────
router.post('/shipment/manual', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const bookingId = String(req.body?.booking_id || '').trim();
    const courierName = String(req.body?.courier_name || '').trim();
    const awb = String(req.body?.awb || '').trim();
    const status = String(req.body?.status || 'Shipped').trim() || 'Shipped';

    if (!bookingId || !courierName || !awb) {
      return res.status(400).json({ error: 'booking_id, courier_name, and awb are required' });
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
      awb,
      shipment_status: 'manual',
      shipment_mode: 'manual',
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
        awb,
        status,
      }),
    });
    const notifyData = await notifyRes.json().catch(() => ({}));
    if (!notifyRes.ok || !notifyData.ok) {
      return res.status(500).json({ error: notifyData.error || 'WhatsApp notification failed' });
    }

    res.json({ success: true, booking_id: booking.id });
  } catch (err) {
    console.error('[dashboard/shipment/manual]', err.message);
    res.status(500).json({ error: err.message });
  }
});

const { buildPackingSlipPdf, buildShippingLabelPdf } = require('../helpers/packingLabels');
const { cartWeightKg, resolveCartLineWeights } = require('../helpers/cartWeight');

async function loadBookingPackPayload(restaurantId, bookingId) {
  const { data: booking, error: bookingErr } = await supabaseAdmin
    .from('bookings')
    .select('id, restaurant_id, customer_phone, customer_name, order_ref, delivery_address, meta, created_at')
    .eq('restaurant_id', restaurantId)
    .eq('id', bookingId)
    .maybeSingle();
  if (bookingErr) throw bookingErr;
  if (!booking) return null;

  const { data: restaurant } = await supabaseAdmin
    .from('tenants')
    .select('id, name, display_name, contact_phone, whatsapp_number, postal_code, gstin, fssai_license, receipt_tagline, packaging_weight_grams')
    .eq('id', restaurantId)
    .maybeSingle();

  const meta = booking.meta || {};
  const cart = meta.web_cart_submission?.items
    || meta.cart
    || meta.items
    || [];

  let lines = [];
  if (Array.isArray(cart) && cart.length) {
    const { data: menuRows } = await supabaseAdmin
      .from('menu_items')
      .select('id, retailer_id, name, weight_grams, pack_size_label, size_label, item_type, meta, price')
      .eq('restaurant_id', restaurantId)
      .is('archived_at', null);
    const weighted = resolveCartLineWeights(cart, menuRows || []);
    lines = weighted.map((l) => {
      const src = (menuRows || []).find(
        (m) => String(m.id) === String(l.id) || String(m.retailer_id) === String(l.id),
      );
      return {
        name: l.name || src?.name || 'Item',
        qty: l.qty,
        pack: src?.pack_size_label || src?.size_label || '',
        weight_grams: l.weight_grams,
        price: l.price ?? src?.price,
      };
    });
  } else {
    // Fallback: recent order_items for this phone today
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('customer_phone', booking.customer_phone)
      .order('created_at', { ascending: false })
      .limit(3);
    const orderIds = (orders || []).map((o) => o.id);
    if (orderIds.length) {
      const { data: oi } = await supabaseAdmin
        .from('order_items')
        .select('quantity, unit_price, menu_item:menu_item_id(name, weight_grams, pack_size_label, size_label)')
        .in('order_id', orderIds);
      lines = (oi || []).map((r) => ({
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

/** Today's packing slips as a simple multi-page PDF (one slip per booking with delivery). */
router.get('/packing-slips/today', authenticateToken, getRestaurantId, requireOutlet, async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const { data: bookings, error } = await supabaseAdmin
      .from('bookings')
      .select('id, order_ref, customer_name, customer_phone, delivery_address, meta, created_at')
      .eq('restaurant_id', req.restaurant_id)
      .gte('created_at', start.toISOString())
      .order('created_at', { ascending: true })
      .limit(80);
    if (error) throw error;

    const shipped = (bookings || []).filter((b) => {
      const meta = b.meta || {};
      return b.delivery_address || meta.delivery_address || meta.web_cart_submission;
    });

    if (!shipped.length) {
      return res.status(404).json({ error: 'No shippable bookings today' });
    }

    const doc = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: false });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    for (const b of shipped) {
      const payload = await loadBookingPackPayload(req.restaurant_id, b.id);
      if (!payload) continue;
      doc.addPage();
      // Inline compact slip (reuse fields without nested PDFDocument)
      const r = payload.restaurant;
      doc.fontSize(16).text(r.name || 'Packing slip');
      if (r.fssai_license) doc.fontSize(9).text(`FSSAI ${r.fssai_license}`);
      doc.moveDown(0.4);
      doc.fontSize(11).text(`Order ${payload.booking.order_ref || b.id}`);
      doc.fontSize(10).text(payload.booking.customer_name || '');
      doc.text(payload.booking.customer_phone || '');
      if (payload.booking.delivery_address || payload.booking.meta?.delivery_address) {
        doc.text(payload.booking.delivery_address || payload.booking.meta.delivery_address, { width: 480 });
      }
      doc.moveDown(0.3);
      for (const line of payload.lines) {
        doc.text(`${line.qty}× ${line.name}${line.pack ? ` (${line.pack})` : ''}`);
      }
      if (payload.booking.meta?.awb) {
        doc.moveDown(0.3);
        doc.text(`AWB ${payload.booking.meta.awb} · ${payload.booking.meta.courier_name || ''}`);
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
