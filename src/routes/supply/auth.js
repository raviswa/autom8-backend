// src/routes/supply/auth.js
// ============================================================================
// Munafe Supply — Module 1: Auth & Supplier Profile
//
// Endpoints:
//   POST /api/supply/auth/register     — create supplier account
//   POST /api/supply/auth/login        — login, returns Supabase session tokens
//   POST /api/supply/auth/refresh      — refresh access token
//   POST /api/supply/auth/forgot-password — send reset email
//   GET  /api/supply/auth/me           — get own profile (authenticated)
//   PUT  /api/supply/profile           — update profile (authenticated)
//
// Auth uses identical Supabase JWT infrastructure as restaurant employees.
// Frontend stores tokens under supply_authToken / supply_refreshToken keys
// to avoid collision with the restaurant session in the same browser.
//
// Register in server.js (before the catch-all /api pos router):
//   app.use('/api/supply/auth', require('./src/routes/supply/auth'));
//   app.use('/api/supply/profile', require('./src/routes/supply/auth'));  // for PUT /profile
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabase, supabaseAdmin }  = require('../../config/supabase');
const { authenticateToken }        = require('../../middleware/auth');
const { getSupplierContext }       = require('../../middleware/supplyAuth');
const { listSupplyLobTypes }       = require('../../config/supplyCatalogSchemas');

// ── POST /api/supply/auth/register ────────────────────────────────────────────
// Creates a Supabase auth user + suppliers row in one transaction.
// On auth-user creation success but suppliers insert failure: rolls back by
// deleting the auth user, so no orphaned Supabase users are left behind.

router.post('/register', async (req, res) => {
  let authUserId = null;
  try {
    const {
      email,
      password,
      name,
      business_name,
      phone,
      gstin,
      address,
      city,
      state,
      pincode,
      lob_type,
    } = req.body;

    // ── Validate required fields ──────────────────────────────────────────────
    if (!email?.trim())          return res.status(400).json({ error: 'Email is required' });
    if (!password)               return res.status(400).json({ error: 'Password is required' });
    if (password.length < 8)     return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!name?.trim())           return res.status(400).json({ error: 'Contact name is required' });
    if (!business_name?.trim())  return res.status(400).json({ error: 'Business name is required' });
    if (!phone?.trim())          return res.status(400).json({ error: 'Phone number is required' });

    let resolvedLob = 'food_service';
    if (lob_type !== undefined && lob_type !== null && String(lob_type).trim() !== '') {
      resolvedLob = String(lob_type).trim().toLowerCase();
      if (!listSupplyLobTypes().includes(resolvedLob)) {
        return res.status(400).json({
          error: `lob_type must be one of: ${listSupplyLobTypes().join(', ')}`,
        });
      }
    }

    // ── Check for duplicate email ─────────────────────────────────────────────
    const { data: existing } = await supabaseAdmin
      .from('suppliers')
      .select('id')
      .eq('email', email.trim().toLowerCase())
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // ── Create Supabase auth user ─────────────────────────────────────────────
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email:         email.trim().toLowerCase(),
      password,
      email_confirm: true,   // auto-confirm; add email verification flow later if needed
    });

    if (authError) {
      console.error('[supply/register] Auth user creation failed:', authError.message);
      return res.status(400).json({ error: authError.message });
    }

    authUserId = authData.user.id;

    // ── Create supplier profile ───────────────────────────────────────────────
    const { data: supplier, error: supplierError } = await supabaseAdmin
      .from('suppliers')
      .insert({
        auth_user_id:  authUserId,
        name:          name.trim(),
        business_name: business_name.trim(),
        email:         email.trim().toLowerCase(),
        phone:         phone.trim(),
        gstin:         gstin?.trim() || null,
        address:       address?.trim() || null,
        city:          city?.trim() || null,
        state:         state?.trim() || null,
        pincode:       pincode?.trim() || null,
        lob_type:      resolvedLob,
      })
      .select()
      .single();

    if (supplierError) {
      // Rollback: remove the auth user so they can retry with the same email
      console.error('[supply/register] Supplier insert failed:', supplierError.message);
      await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(rollbackErr =>
        console.error('[supply/register] Auth rollback failed:', rollbackErr.message)
      );
      return res.status(500).json({ error: `Registration failed: ${supplierError.message}` });
    }

    console.log(`[supply/register] ✅ New supplier: ${supplier.business_name} (${supplier.id})`);

    res.status(201).json({
      success:     true,
      message:     'Account created successfully. You can now log in.',
      supplier_id: supplier.id,
    });

  } catch (err) {
    // If auth user was created but something else threw, attempt rollback
    if (authUserId) {
      await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => {});
    }
    console.error('[supply/register] Unexpected error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/supply/auth/login ───────────────────────────────────────────────
// Mirrors the exact response shape of /api/auth/login for frontend consistency:
//   { success, token, refreshToken, user }

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email?.trim() || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // ── Supabase auth ─────────────────────────────────────────────────────────
    const { data: sessionData, error: authError } = await supabase.auth.signInWithPassword({
      email:    email.trim().toLowerCase(),
      password,
    });

    if (authError) {
      // Supabase returns 'Invalid login credentials' for wrong email/password
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // ── Fetch supplier profile ────────────────────────────────────────────────
    const { data: supplier, error: supplierError } = await supabaseAdmin
      .from('suppliers')
      .select([
        'id', 'name', 'business_name', 'email', 'phone',
        'waba_phone', 'waba_phone_number_id',
        'gstin', 'city', 'state', 'logo_url',
        'ordering_open_time', 'ordering_cutoff_time',
        'always_open', 'timezone', 'is_active', 'lob_type',
      ].join(', '))
      .eq('auth_user_id', sessionData.user.id)
      .maybeSingle();

    if (supplierError || !supplier) {
      console.error('[supply/login] Supplier profile not found for auth user:', sessionData.user.id);
      return res.status(401).json({
        error: 'Supplier account not set up. No profile found. Contact support.',
      });
    }

    if (!supplier.is_active) {
      return res.status(403).json({ error: 'Your account has been deactivated. Contact support.' });
    }

    console.log(`[supply/login] ✅ ${supplier.business_name} logged in`);

    res.json({
      success:      true,
      token:        sessionData.session.access_token,
      refreshToken: sessionData.session.refresh_token,
      user:         supplier,
    });

  } catch (err) {
    console.error('[supply/login] Unexpected error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/supply/auth/refresh ─────────────────────────────────────────────
// Identical pattern to /api/auth/refresh.

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });

    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data?.session) {
      return res.status(401).json({ error: error?.message || 'Invalid or expired refresh token' });
    }

    res.json({
      success:      true,
      token:        data.session.access_token,
      refreshToken: data.session.refresh_token,
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ── POST /api/supply/auth/forgot-password ─────────────────────────────────────
// Sends Supabase password reset email. Always returns success (no enumeration).

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'Email is required' });

    const normalized = email.trim().toLowerCase();

    // Only send if supplier account exists and is active
    const { data: supplier } = await supabaseAdmin
      .from('suppliers')
      .select('id, is_active')
      .eq('email', normalized)
      .maybeSingle();

    if (supplier?.is_active) {
      const redirectTo = req.headers.origin
        ? `${req.headers.origin}/supply/reset-password`
        : process.env.SUPPLY_FORM_BASE_URL
          ? `${process.env.SUPPLY_FORM_BASE_URL}/reset-password`
          : undefined;

      await supabaseAdmin.auth.admin.generateLink({
        type:        'recovery',
        email:       normalized,
        options:     { redirectTo },
      });
    }

    res.json({
      success: true,
      message: 'If an account exists for that email, a password reset link has been sent.',
    });
  } catch (err) {
    console.error('[supply/forgot-password]', err.message);
    res.status(500).json({ error: 'Could not send reset email. Please try again.' });
  }
});

// ── GET /api/supply/auth/me ────────────────────────────────────────────────────
// Returns the authenticated supplier's full profile.

router.get('/me', authenticateToken, getSupplierContext, async (req, res) => {
  try {
    res.json({ success: true, supplier: req.supplier });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/supply/auth/profile ──────────────────────────────────────────────
// Update supplier business profile.
// Registered in server.js as app.use('/api/supply/auth', router) — so this
// is accessible at PUT /api/supply/auth/profile

router.put('/profile', authenticateToken, getSupplierContext, async (req, res) => {
  try {
    const {
      name,
      business_name,
      phone,
      waba_phone,
      gstin,
      address,
      city,
      state,
      pincode,
      logo_url,
      ordering_open_time,
      ordering_cutoff_time,
      always_open,
      lob_type,
    } = req.body;

    // Build update object — only include defined fields
    const updates = {};
    if (name               !== undefined) updates.name               = name?.trim() || null;
    if (business_name      !== undefined) updates.business_name      = business_name?.trim() || null;
    if (phone              !== undefined) updates.phone              = phone?.trim() || null;
    if (waba_phone         !== undefined) updates.waba_phone         = waba_phone?.trim() || null;
    if (gstin              !== undefined) updates.gstin              = gstin?.trim() || null;
    if (address            !== undefined) updates.address            = address?.trim() || null;
    if (city               !== undefined) updates.city               = city?.trim() || null;
    if (state              !== undefined) updates.state              = state?.trim() || null;
    if (pincode            !== undefined) updates.pincode            = pincode?.trim() || null;
    if (logo_url           !== undefined) updates.logo_url           = logo_url || null;
    if (ordering_open_time !== undefined) updates.ordering_open_time = ordering_open_time;
    if (ordering_cutoff_time !== undefined) updates.ordering_cutoff_time = ordering_cutoff_time;
    if (always_open        !== undefined) updates.always_open        = Boolean(always_open);
    if (lob_type !== undefined) {
      const nextLob = String(lob_type || '').trim().toLowerCase();
      if (!listSupplyLobTypes().includes(nextLob)) {
        return res.status(400).json({
          error: `lob_type must be one of: ${listSupplyLobTypes().join(', ')}`,
        });
      }
      updates.lob_type = nextLob;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields provided to update' });
    }

    const { data, error } = await supabaseAdmin
      .from('suppliers')
      .update(updates)
      .eq('id', req.supplier_id)
      .select()
      .single();

    if (error) {
      console.error('[supply/profile] Update failed:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`[supply/profile] ✅ Updated profile for supplier ${req.supplier_id}`);
    res.json({ success: true, supplier: data });

  } catch (err) {
    console.error('[supply/profile] Unexpected error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
