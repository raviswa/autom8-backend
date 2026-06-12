// src/middleware/auth.js
// ============================================================================
// Authentication + context middleware
//
// authenticateToken  — validates Bearer JWT via Supabase admin
// getRestaurantId    — attaches restaurant_id, brand_id, user_role, scope
//                      Handles both outlet employees AND brand-level employees
//                      (brand_owner / brand_manager have restaurant_id = NULL)
// ============================================================================

'use strict';

const { supabaseAdmin } = require('../config/supabase');

const BRAND_ROLES = ['brand_owner', 'brand_manager'];
const SETTINGS_ROLES = ['owner', 'manager', 'brand_owner', 'brand_manager'];

async function resolveBrandOutletId(brandId, req) {
  const headerId = req.headers['x-restaurant-id'];
  if (headerId) {
    const { data: outlet } = await supabaseAdmin
      .from('restaurants')
      .select('id')
      .eq('id', headerId)
      .eq('brand_id', brandId)
      .eq('is_active', true)
      .maybeSingle();
    if (outlet?.id) return outlet.id;
  }

  const { data: outlets } = await supabaseAdmin
    .from('restaurants')
    .select('id')
    .eq('brand_id', brandId)
    .eq('is_active', true)
    .limit(2);

  if (outlets?.length === 1) return outlets[0].id;
  return null;
}

function canManageRestaurantSettings(role) {
  return SETTINGS_ROLES.includes(role);
}

// ── authenticateToken ────────────────────────────────────────────────────────
// Validates the Bearer JWT via Supabase admin client.
// Attaches req.user = { sub, email } for downstream middleware.

const authenticateToken = async (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = { sub: user.id, email: user.email };
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Authentication failed' });
  }
};

// ── getRestaurantId ──────────────────────────────────────────────────────────
// Looks up the employee record to attach context to the request.
//
// For outlet employees:
//   req.restaurant_id — the employee's outlet UUID
//   req.brand_id      — the outlet's brand UUID (may be null for standalone)
//   req.user_role     — 'owner' | 'manager' | 'kitchen_staff' | ...
//   req.scope         — 'outlet'
//
// For brand employees (brand_owner, brand_manager):
//   req.restaurant_id — null  (brand employees are not tied to a single outlet)
//   req.brand_id      — the brand UUID
//   req.user_role     — 'brand_owner' | 'brand_manager'
//   req.scope         — 'brand'
//
// Endpoints that require a specific outlet_id should use req.brand_id +
// verify the requested outlet belongs to that brand, rather than relying
// on req.restaurant_id directly.

const getRestaurantId = async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('employees')
      .select('restaurant_id, brand_id, role, is_active')
      .eq('id', req.user.sub)
      .single();

    if (error) return res.status(401).json({ error: `Employee lookup failed: ${error.message}` });
    if (!data)  return res.status(401).json({ error: 'Employee profile not found.' });

    if (!data.is_active)
      return res.status(403).json({ error: 'Your account has been deactivated. Contact your manager.' });

    // ── Brand-level employees: no restaurant_id, scope = brand ───────────────
    if (BRAND_ROLES.includes(data.role)) {
      if (!data.brand_id)
        return res.status(403).json({ error: 'Brand employee has no brand assigned.' });

      req.restaurant_id = await resolveBrandOutletId(data.brand_id, req);
      req.brand_id      = data.brand_id;
      req.user_role     = data.role;
      req.scope         = 'brand';
      return next();
    }

    // ── Outlet-level employees ────────────────────────────────────────────────
    if (data.restaurant_id) {
      req.restaurant_id = data.restaurant_id;
      req.brand_id      = data.brand_id ?? null;
      req.user_role     = data.role;
      req.scope         = 'outlet';
      return next();
    }

    // ── Fallback for dev/staging (single-restaurant environment only) ─────────
    const { data: restaurants } = await supabaseAdmin
      .from('restaurants')
      .select('id')
      .eq('is_active', true)
      .limit(2);

    if (restaurants?.length === 1) {
      req.restaurant_id = restaurants[0].id;
      req.brand_id      = data.brand_id ?? null;
      req.user_role     = data.role;
      req.scope         = 'outlet';
      return next();
    }

    return res.status(401).json({ error: 'Employee has no restaurant assigned.' });

  } catch (err) {
    res.status(401).json({ error: `Auth middleware failed: ${err.message}` });
  }
};

module.exports = {
  authenticateToken,
  getRestaurantId,
  canManageRestaurantSettings,
  SETTINGS_ROLES,
};
