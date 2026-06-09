// src/routes/dashboard.js
// ============================================================================
// OWNER DASHBOARD ROUTES — drop-in replacement for the broken inline routes
// Mount BEFORE the broken inline definitions in server.js with:
//   app.use('/api/dashboard', require('./src/routes/dashboard'));
// Express uses the first matching route, so this file wins automatically.
// ============================================================================

const express        = require('express');
const router         = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase');

// ── Auth helper — extracts + validates Bearer token, attaches restaurantId ───
async function auth(req, res) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) { res.status(401).json({ error: 'No token' }); return null; }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) { res.status(403).json({ error: 'Invalid token' }); return null; }

  const { data: userData } = await supabaseAdmin
    .from('users').select('restaurant_id').eq('id', user.id).single();

  if (!userData?.restaurant_id) {
    res.status(403).json({ error: 'No restaurant linked to this account' });
    return null;
  }
  return userData.restaurant_id;
}

// ── GET /api/dashboard/waba ───────────────────────────────────────────────────
router.get('/waba', async (req, res) => {
  try {
    const restaurantId = await auth(req, res);
    if (!restaurantId) return;

    const { data, error } = await supabaseAdmin
      .from('restaurants')
      .select('id, name, waba_id, whatsapp_number, display_name, manager_phone, timezone, dining_duration_minutes, payment_mode')
      .eq('id', restaurantId)
      .maybeSingle();

    if (error) console.error('[dashboard/waba]', error.message);
    res.json({ success: true, restaurant: data ?? null });
  } catch (err) {
    console.error('[dashboard/waba]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/wa-orders ─────────────────────────────────────────────
// Source: walk_in_tokens (merged DB — no bookings/customers table)
router.get('/wa-orders', async (req, res) => {
  try {
    const restaurantId = await auth(req, res);
    if (!restaurantId) return;

    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const { data, error } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('id, arrived_at, status, type, pax, name, phone, table_number')
      .eq('restaurant_id', restaurantId)
      .gte('arrived_at', start)
      .lte('arrived_at', end)
      .order('arrived_at', { ascending: false })
      .limit(500);

    if (error) {
      console.error('[dashboard/wa-orders]', error.message);
      return res.status(500).json({ error: error.message });
    }

    const orders = (data ?? []).map(t => ({
      id:           t.id,
      created_at:   t.arrived_at,
      service_type: t.type,
      status:       t.status,
      party_size:   t.pax,
      token_number: t.id,
      total_amount: null,
      customers:    { name: t.name, phone: t.phone },
    }));

    console.log(`[dashboard/wa-orders] ${orders.length} tokens`);
    res.json({ success: true, orders });
  } catch (err) {
    console.error('[dashboard/wa-orders]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/cancel-stats ──────────────────────────────────────────
router.get('/cancel-stats', async (req, res) => {
  try {
    const restaurantId = await auth(req, res);
    if (!restaurantId) return;

    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const [cancelRes, totalRes, bcRes, btRes] = await Promise.all([
      supabaseAdmin.from('orders').select('total_amount')
        .eq('restaurant_id', restaurantId).eq('status', 'cancelled')
        .gte('created_at', start).lte('created_at', end),
      supabaseAdmin.from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantId)
        .gte('created_at', start).lte('created_at', end),
      supabaseAdmin.from('walk_in_tokens')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantId)
        .in('status', ['completed', 'cancelled'])
        .gte('arrived_at', start).lte('arrived_at', end),
      supabaseAdmin.from('walk_in_tokens')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantId)
        .gte('arrived_at', start).lte('arrived_at', end),
    ]);

    const orderCancels   = cancelRes.data ?? [];
    const totalOrders    = totalRes.count  ?? 0;
    const orderRevLost   = orderCancels.reduce((s, o) => s + (o.total_amount ?? 0), 0);
    const bookingCancels = bcRes.count ?? 0;
    const totalBookings  = btRes.count ?? 0;

    res.json({
      success:       true,
      orderCancels:  orderCancels.length,
      orderRevLost,
      totalOrders,
      orderRate:     totalOrders > 0 ? Math.round((orderCancels.length / totalOrders) * 100) : 0,
      bookingCancels,
      totalBookings,
      bookingRate:   totalBookings > 0 ? Math.round((bookingCancels / totalBookings) * 100) : 0,
    });
  } catch (err) {
    console.error('[dashboard/cancel-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
