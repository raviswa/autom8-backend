'use strict';

/**
 * Platform ops reads for autom8.works owner console.
 * All routes require requireKdsSecret (same as referrals admin).
 *
 *   GET /api/admin/tenants
 *   GET /api/admin/registration-failures
 */

const express = require('express');
const router = express.Router();

const { supabaseAdmin } = require('../../config/supabase');
const { requireKdsSecret } = require('../../middleware/internalAuth');

router.use(requireKdsSecret);

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ── GET /api/admin/tenants ────────────────────────────────────────────────────

router.get('/tenants', async (req, res) => {
  try {
    const page = clampInt(req.query.page, 1, 1, 100000);
    const limit = clampInt(req.query.limit, 25, 1, 100);
    const offset = (page - 1) * limit;
    const q = String(req.query.q || '').trim();

    let query = supabaseAdmin
      .from('tenants')
      .select(
        'id, name, display_name, email, contact_email, whatsapp_number, waba_id, lob_type, is_active, created_at, brand_id',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (q) {
      // Simple ilike across name / email / whatsapp
      query = query.or(
        `name.ilike.%${q}%,display_name.ilike.%${q}%,email.ilike.%${q}%,contact_email.ilike.%${q}%,whatsapp_number.ilike.%${q}%`,
      );
    }

    const { data: tenants, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const rows = tenants || [];
    const ids = rows.map((t) => t.id);

    let integrations = [];
    let menuCounts = {};
    let subscriptions = [];

    if (ids.length) {
      const [intRes, menuRes, subRes] = await Promise.all([
        supabaseAdmin
          .from('tenant_integrations')
          .select('id, restaurant_id, phone_number_id, waba_id, is_active')
          .in('restaurant_id', ids)
          .eq('provider', 'meta')
          .eq('channel', 'whatsapp')
          .eq('is_active', true),
        supabaseAdmin
          .from('menu_items')
          .select('restaurant_id')
          .in('restaurant_id', ids),
        supabaseAdmin
          .from('tenant_subscriptions')
          .select('restaurant_id, status, trial_ends_at, renews_at, features')
          .in('restaurant_id', ids),
      ]);

      integrations = intRes.data || [];
      subscriptions = subRes.data || [];
      for (const row of menuRes.data || []) {
        menuCounts[row.restaurant_id] = (menuCounts[row.restaurant_id] || 0) + 1;
      }
    }

    const intByRest = Object.fromEntries(
      integrations.map((i) => [i.restaurant_id, i]),
    );
    const subByRest = Object.fromEntries(
      subscriptions.map((s) => [s.restaurant_id, s]),
    );

    const items = rows.map((t) => {
      const integ = intByRest[t.id];
      const sub = subByRest[t.id];
      return {
        id: t.id,
        name: t.name,
        display_name: t.display_name,
        email: t.contact_email || t.email || null,
        whatsapp_number: t.whatsapp_number || null,
        waba_id: t.waba_id || integ?.waba_id || null,
        lob_type: t.lob_type || 'restaurant',
        is_active: t.is_active !== false,
        brand_id: t.brand_id || null,
        created_at: t.created_at,
        whatsapp_connected: Boolean(integ?.id || integ?.phone_number_id || (t.whatsapp_number && t.waba_id)),
        catalog_item_count: menuCounts[t.id] || 0,
        subscription: sub
          ? {
              status: sub.status || null,
              trial_ends_at: sub.trial_ends_at || null,
              renews_at: sub.renews_at || null,
              paid_features: Array.isArray(sub.features) ? sub.features : [],
            }
          : null,
      };
    });

    res.json({
      success: true,
      page,
      limit,
      total: count ?? items.length,
      items,
    });
  } catch (err) {
    console.error('[admin/tenants]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/registration-failures ──────────────────────────────────────

router.get('/registration-failures', async (req, res) => {
  try {
    const page = clampInt(req.query.page, 1, 1, 100000);
    const limit = clampInt(req.query.limit, 25, 1, 100);
    const offset = (page - 1) * limit;
    const email = String(req.query.email || '').trim().toLowerCase();

    let query = supabaseAdmin
      .from('registration_failures')
      .select(
        'id, email, slug, restaurant_id, auth_user_id, failed_step, error_message, meta, created_at',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (email) {
      query = query.ilike('email', `%${email}%`);
    }

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({
      success: true,
      page,
      limit,
      total: count ?? (data || []).length,
      items: data || [],
    });
  } catch (err) {
    console.error('[admin/registration-failures]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
