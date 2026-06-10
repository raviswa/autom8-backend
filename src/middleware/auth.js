// src/middleware/auth.js
// Extracted from server.js — authenticateToken + getRestaurantId
//
// FIX 1: getRestaurantId now queries 'employees' (renamed from 'users').
//        The migration creates a VIEW public.users as a fallback, but
//        pointing here directly is cleaner and removes the VIEW dependency.
//
// FIX 2: authenticateToken now uses supabaseAdmin.auth.getUser(token)
//        instead of supabase.auth.getUser(token).
//        The anon client requires ANON_KEY env var to be set correctly;
//        if it's missing or misconfigured, every request returns 403.
//        supabaseAdmin uses SERVICE_ROLE_KEY which is always required
//        for the server to start — so if admin works, auth works.

const { supabaseAdmin } = require('../config/supabase');

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
// Looks up the employee record to attach restaurant_id and role to the request.
// Must run after authenticateToken (depends on req.user.sub).

const getRestaurantId = async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('employees')
      .select('restaurant_id, role, is_active')
      .eq('id', req.user.sub)
      .single();

    if (error) return res.status(401).json({ error: `Employee lookup failed: ${error.message}` });
    if (!data)  return res.status(401).json({ error: 'Employee profile not found.' });

    // Terminated employees cannot access the system
    if (data.is_active === false)
      return res.status(403).json({ error: 'Your account has been deactivated. Contact your manager.' });

    if (!data.restaurant_id) {
      // Dev/staging fallback: if this employee has no restaurant assigned
      // and there is exactly one restaurant in the DB, use it.
      // This never triggers in production (every employee has restaurant_id at creation).
      const { data: restaurants } = await supabaseAdmin
        .from('restaurants')
        .select('id')
        .eq('is_active', true)
        .limit(2);

      if (restaurants?.length === 1) {
        req.restaurant_id = restaurants[0].id;
        req.user_role     = data.role;
        return next();
      }
      return res.status(401).json({ error: 'Employee has no restaurant assigned.' });
    }

    req.restaurant_id = data.restaurant_id;
    req.user_role     = data.role;
    next();
  } catch (err) {
    res.status(401).json({ error: `Auth middleware failed: ${err.message}` });
  }
};

module.exports = { authenticateToken, getRestaurantId };
