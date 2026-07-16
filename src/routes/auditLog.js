// src/routes/auditLog.js
// Owner / brand_owner paginated read of portal audit_log.

'use strict';

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');

const OWNER_ROLES = ['owner', 'brand_owner'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function requireOwnerRole(req, res, next) {
  if (!OWNER_ROLES.includes(req.user_role)) {
    return res.status(403).json({ error: 'Owner access required.' });
  }
  next();
}

async function resolveTargetRestaurantId(req) {
  const requested =
    req.query?.restaurant_id || req.restaurant_id || null;

  if (!requested) {
    const err = new Error(
      'restaurant_id is required (query or x-restaurant-id for brand accounts)',
    );
    err.status = 400;
    throw err;
  }

  if (req.scope === 'brand' && req.brand_id) {
    const { data: outlet } = await supabaseAdmin
      .from('tenants')
      .select('id')
      .eq('id', requested)
      .eq('brand_id', req.brand_id)
      .eq('is_active', true)
      .maybeSingle();
    if (!outlet?.id) {
      const err = new Error('Outlet not found under your brand.');
      err.status = 403;
      throw err;
    }
    return outlet.id;
  }

  if (req.restaurant_id && requested !== req.restaurant_id) {
    const err = new Error('Cannot view audit log for another outlet.');
    err.status = 403;
    throw err;
  }

  return requested;
}

// GET /api/audit-log
router.get('/', authenticateToken, getRestaurantId, requireOwnerRole, async (req, res) => {
  try {
    const restaurantId = await resolveTargetRestaurantId(req);
    const {
      portal,
      employee_id,
      from,
      to,
      limit: rawLimit,
      offset: rawOffset,
    } = req.query;

    const limit = Math.min(
      Math.max(parseInt(rawLimit, 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);

    let query = supabaseAdmin
      .from('audit_log')
      .select(
        'id, restaurant_id, lob_type, portal, action, entity_type, entity_id, actor_employee_id, actor_role, before, after, created_at',
        { count: 'exact' },
      )
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (portal) query = query.eq('portal', portal);
    if (employee_id) query = query.eq('actor_employee_id', employee_id);
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      success: true,
      restaurant_id: restaurantId,
      entries: data || [],
      pagination: {
        limit,
        offset,
        total: count ?? (data || []).length,
      },
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[audit-log]', err.message);
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
