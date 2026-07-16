// src/routes/portalAccess.js
// Owner / brand_owner APIs for fine-grained employee_portal_access grants.
// Uses hard role checks — not requirePortalAccess (permission source must not depend on itself).

'use strict';

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');
const {
  isValidPortal,
  isValidAccessLevel,
} = require('../config/portalAccess');

const OWNER_ROLES = ['owner', 'brand_owner'];

function requireOwnerRole(req, res, next) {
  if (!OWNER_ROLES.includes(req.user_role)) {
    return res.status(403).json({ error: 'Owner access required.' });
  }
  next();
}

/**
 * Resolve target outlet: body/query restaurant_id override for brand scope,
 * otherwise req.restaurant_id from getRestaurantId (incl. x-restaurant-id).
 * Brand owners may only target outlets under their brand.
 */
async function resolveTargetRestaurantId(req) {
  const requested =
    req.body?.restaurant_id ||
    req.query?.restaurant_id ||
    req.restaurant_id ||
    null;

  if (!requested) {
    const err = new Error(
      'restaurant_id is required (query/body or x-restaurant-id for brand accounts)',
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

  // Outlet owner: must match their linked restaurant
  if (req.restaurant_id && requested !== req.restaurant_id) {
    const err = new Error('Cannot manage portal access for another outlet.');
    err.status = 403;
    throw err;
  }

  return requested;
}

function handleErr(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[portal-access]', err.message);
  res.status(status).json({ error: err.message });
}

// GET /api/portal-access — employees for outlet + their EPA rows
router.get('/', authenticateToken, getRestaurantId, requireOwnerRole, async (req, res) => {
  try {
    const restaurantId = await resolveTargetRestaurantId(req);

    const [{ data: employees, error: empErr }, { data: grants, error: grantErr }] =
      await Promise.all([
        supabaseAdmin
          .from('employees')
          .select('id, full_name, email, phone, role, is_active')
          .eq('restaurant_id', restaurantId)
          .order('full_name', { ascending: true }),
        supabaseAdmin
          .from('employee_portal_access')
          .select(
            'id, employee_id, restaurant_id, lob_type, portal, access_level, granted_by, created_at',
          )
          .eq('restaurant_id', restaurantId),
      ]);

    if (empErr) throw empErr;
    if (grantErr) throw grantErr;

    const byEmployee = {};
    for (const g of grants || []) {
      if (!byEmployee[g.employee_id]) byEmployee[g.employee_id] = [];
      byEmployee[g.employee_id].push(g);
    }

    const rows = (employees || []).map((e) => ({
      ...e,
      portal_access: byEmployee[e.id] || [],
    }));

    res.json({
      success: true,
      restaurant_id: restaurantId,
      employees: rows,
    });
  } catch (err) {
    handleErr(res, err);
  }
});

// POST /api/portal-access — upsert EPA row
router.post('/', authenticateToken, getRestaurantId, requireOwnerRole, async (req, res) => {
  try {
    const restaurantId = await resolveTargetRestaurantId(req);
    const {
      employee_id,
      portal,
      access_level,
      lob_type = null,
    } = req.body || {};

    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
    if (!isValidPortal(portal)) {
      return res.status(400).json({ error: 'Invalid portal value' });
    }
    if (!isValidAccessLevel(access_level)) {
      return res.status(400).json({ error: 'Invalid access_level value' });
    }

    const { data: emp, error: empLookupErr } = await supabaseAdmin
      .from('employees')
      .select('id, restaurant_id')
      .eq('id', employee_id)
      .maybeSingle();
    if (empLookupErr) throw empLookupErr;
    if (!emp || emp.restaurant_id !== restaurantId) {
      return res.status(400).json({ error: 'Employee not found on this outlet.' });
    }

    // Find existing grant with same COALESCE uniqueness semantics
    let existingQuery = supabaseAdmin
      .from('employee_portal_access')
      .select('id')
      .eq('employee_id', employee_id)
      .eq('restaurant_id', restaurantId)
      .eq('portal', portal);

    if (lob_type == null || lob_type === '') {
      existingQuery = existingQuery.is('lob_type', null);
    } else {
      existingQuery = existingQuery.eq('lob_type', lob_type);
    }

    const { data: existing, error: findErr } = await existingQuery.maybeSingle();
    if (findErr) throw findErr;

    const payload = {
      employee_id,
      restaurant_id: restaurantId,
      lob_type: lob_type || null,
      portal,
      access_level,
      granted_by: req.user.sub,
    };

    let row;
    if (existing?.id) {
      const { data, error } = await supabaseAdmin
        .from('employee_portal_access')
        .update({
          access_level,
          granted_by: req.user.sub,
          lob_type: lob_type || null,
        })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      row = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('employee_portal_access')
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      row = data;
    }

    res.json({ success: true, grant: row });
  } catch (err) {
    handleErr(res, err);
  }
});

// DELETE /api/portal-access/:id
router.delete('/:id', authenticateToken, getRestaurantId, requireOwnerRole, async (req, res) => {
  try {
    const restaurantId = await resolveTargetRestaurantId(req);

    const { data: grant, error: findErr } = await supabaseAdmin
      .from('employee_portal_access')
      .select('id, restaurant_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!grant) return res.status(404).json({ error: 'Grant not found' });
    if (grant.restaurant_id !== restaurantId) {
      return res.status(403).json({ error: 'Grant does not belong to this outlet.' });
    }

    const { error } = await supabaseAdmin
      .from('employee_portal_access')
      .delete()
      .eq('id', grant.id);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    handleErr(res, err);
  }
});

module.exports = router;
