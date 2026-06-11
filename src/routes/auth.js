// src/routes/auth.js
// Handles: signup, login, token refresh
//
// Login now returns brand context for brand employees:
//   - scope: 'brand' | 'outlet'
//   - brand_id (if applicable)
//   - outlets[] for brand employees (so frontend can populate outlet selector)

'use strict';

const express  = require('express');
const router   = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase');

const BRAND_ROLES = ['brand_owner', 'brand_manager'];

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { email, password, full_name, restaurant_id, role = 'kitchen_staff' } = req.body;

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: false,
    });
    if (authError) throw authError;

    const { data: userData, error: userError } = await supabaseAdmin
      .from('employees')
      .insert({ id: authData.user.id, email, full_name, restaurant_id, role })
      .select().single();
    if (userError) throw userError;

    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id: authData.user.id, restaurant_id,
        action: 'User signup', details: { email, role },
      });
    } catch (_) {}

    res.json({ success: true, user: userData });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    const { data: emp } = await supabaseAdmin
      .from('employees')
      .select('*')
      .eq('id', data.user.id)
      .single();

    if (!emp)
      return res.status(401).json({ error: 'User account not fully set up. No profile found.' });

    if (!emp.is_active)
      return res.status(403).json({ error: 'Your account has been deactivated. Contact your manager.' });

    await supabaseAdmin.from('employees').update({ last_login: new Date() }).eq('id', data.user.id);

    // ── Build scope-aware user object ─────────────────────────────────────────
    const isBrandEmployee = BRAND_ROLES.includes(emp.role);

    let outlets   = undefined;
    let brandInfo = undefined;

    if (isBrandEmployee && emp.brand_id) {
      // Fetch all active outlets for this brand
      const { data: outletRows } = await supabaseAdmin
        .from('restaurants')
        .select('id, name, outlet_code, sort_order, whatsapp_number, city, is_active')
        .eq('brand_id', emp.brand_id)
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .order('created_at',  { ascending: true });

      outlets = outletRows ?? [];

      // Fetch brand details
      const { data: brand } = await supabaseAdmin
        .from('brands')
        .select('id, name, logo_url, plan, waba_id')
        .eq('id', emp.brand_id)
        .single();

      brandInfo = brand ?? null;
    }

    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id:       data.user.id,
        restaurant_id: emp.restaurant_id ?? null,
        action:        'User login',
        ip_address:    req.ip,
        details:       { scope: isBrandEmployee ? 'brand' : 'outlet', brand_id: emp.brand_id ?? null },
      });
    } catch (_) {}

    res.json({
      success: true,
      token:        data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: {
        ...emp,
        scope:     isBrandEmployee ? 'brand' : 'outlet',
        brand:     brandInfo,
        outlets,   // populated only for brand employees; undefined for outlet employees
      },
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw error;
    res.json({
      success:      true,
      token:        data.session.access_token,
      refreshToken: data.session.refresh_token,
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

module.exports = router;
