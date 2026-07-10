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
const { authenticateToken, getRestaurantId } = require('../middleware/auth');

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
  'id', 'name', 'waba_id', 'whatsapp_number', 'display_name', 'manager_phone', 'meta_catalog_id',
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
].join(', ');

const RESTAURANT_SELECT_BASE = [
  'id', 'name', 'waba_id', 'whatsapp_number', 'display_name', 'manager_phone', 'meta_catalog_id',
  'timezone', 'dining_duration_minutes', 'payment_mode',
  'takeaway_fulfillment_mode', 'fulfillment_sections', 'opening_hours',
  'lob_type',   // ← add this
].join(', ');

async function fetchRestaurantRow(restaurantId) {
  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select(RESTAURANT_SELECT_FULL)
    .eq('id', restaurantId)
    .maybeSingle();

  if (!error) return { data, error: null };

  if (/kitchen_workflow|kot_printer|meta_catalog_id|parcel_charge_per_item|takeaway_ready_range|delivery_ready_range|kitchen_busy|restaurant_type|delivery_charge|scheduled_delivery|scheduled_takeaway|max_delivery_radius/i.test(error.message)) {
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
    }
    return fallback;
  }
  return { data: null, error };
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

    const amountByToken = {};
    const amountByPhone = {};

    for (const row of orderRows) {
      const amount = Number(row.total_amount) || 0;
      if (amount <= 0) continue;

      if (row.token_id) {
        amountByToken[row.token_id] = (amountByToken[row.token_id] || 0) + amount;
      } else {
        const phoneKey = normPhone(row.customer_phone);
        if (!phoneKey) continue;
        amountByPhone[phoneKey] = (amountByPhone[phoneKey] || 0) + amount;
      }
    }

    const orders = tokens.map(t => {
      const tokenAmount = amountByToken[t.id];
      const phoneAmount = amountByPhone[normPhone(t.phone)];
      const resolvedAmount = tokenAmount != null ? tokenAmount : (phoneAmount || 0);

      return {
        id:           t.id,
        created_at:   t.arrived_at,
        service_type: t.type,
        status:       t.status,
        party_size:   t.pax,
        token_number: t.id,
        total_amount: Math.round(resolvedAmount * 100) / 100,
        amount_match_mode: tokenAmount != null ? 'token_id_exact' : (phoneAmount != null ? 'phone_fallback' : 'none'),
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
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const insights = await computeDashboardInsights(supabaseAdmin, req.restaurant_id, start, end);
    res.json({ success: true, ...insights });
  } catch (err) {
    console.error('[dashboard/insights]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
