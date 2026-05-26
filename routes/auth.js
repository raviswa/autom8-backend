// src/routes/auth.js
// Handles: signup, login, token refresh
// Extracted from server.js — no logic changes, just moved here.

const express = require('express');
const router  = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase');

// ── POST /api/auth/signup ────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { email, password, full_name, restaurant_id, role = 'kitchen_staff' } = req.body;

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: false,
    });
    if (authError) throw authError;

    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
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

// ── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    const { data: userDetails } = await supabaseAdmin
      .from('users').select('*').eq('id', data.user.id).single();
    if (!userDetails)
      return res.status(401).json({ error: 'User account not fully set up. No profile found.' });

    await supabaseAdmin.from('users').update({ last_login: new Date() }).eq('id', data.user.id);

    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id: data.user.id, restaurant_id: userDetails.restaurant_id,
        action: 'User login', ip_address: req.ip,
      });
    } catch (_) {}

    res.json({
      success: true, user: userDetails,
      token: data.session.access_token, refreshToken: data.session.refresh_token,
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ── POST /api/auth/refresh ───────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw error;
    res.json({
      success: true,
      token: data.session.access_token, refreshToken: data.session.refresh_token,
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

module.exports = router;
