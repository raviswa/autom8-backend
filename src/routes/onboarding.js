// src/routes/onboarding.js
// Handles: restaurant registration + default user creation
// This is the endpoint the WordPress plugin calls when a new restaurant signs up.

const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../config/supabase');

// ── POST /api/onboarding/register ────────────────────────────────────────────
// Creates a new restaurant + owner user in one atomic step.
// Called by the WordPress plugin after payment is confirmed.
//
// Body: { name, email, phone, owner_name, owner_password, whatsapp_number?,
//         waba_id?, timezone?, dining_duration_minutes?, payment_mode? }

router.post('/register', async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      owner_name,
      owner_password,
      whatsapp_number        = null,
      waba_id                = null,
      timezone               = 'Asia/Kolkata',
      dining_duration_minutes = 90,
      payment_mode           = 'prepay',
    } = req.body;

    if (!name || !email || !owner_name || !owner_password)
      return res.status(400).json({ error: 'name, email, owner_name, owner_password are required' });

    // 1. Create restaurant row
    const { data: restaurant, error: restError } = await supabaseAdmin
      .from('restaurants')
      .insert({
        name,
        email,
        phone:                  phone || null,
        whatsapp_number:        whatsapp_number,
        waba_id:                waba_id,
        timezone,
        dining_duration_minutes,
        payment_mode,
        is_active:              true,
        subscribed_features:    ['dine_in', 'takeaway', 'delivery', 'reserve_table'],
      })
      .select()
      .single();
    if (restError) throw restError;

    // 2. Create Supabase Auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password:      owner_password,
      email_confirm: true,
    });
    if (authError) {
      // Roll back restaurant if auth user creation fails
      await supabaseAdmin.from('restaurants').delete().eq('id', restaurant.id);
      throw authError;
    }

    // 3. Create users table row
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .insert({
        id:            authData.user.id,
        restaurant_id: restaurant.id,
        email,
        full_name:     owner_name,
        phone:         phone || null,
        role:          'owner',
      })
      .select()
      .single();
    if (userError) throw userError;

    // 4. Audit log
    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id:       authData.user.id,
        restaurant_id: restaurant.id,
        action:        'Restaurant registered',
        details:       { name, email, whatsapp_number, source: 'wordpress_plugin' },
      });
    } catch (_) {}

    console.log(`[onboarding] ✅ New restaurant: ${name} (${restaurant.id}) — owner: ${email}`);

    res.status(201).json({
      success:       true,
      restaurant_id: restaurant.id,
      user_id:       user.id,
      region:        req.region?.region || process.env.REGION || 'IN',
    });

  } catch (err) {
    console.error('[onboarding/register]', err.message);
    // Surface friendly messages for common conflicts
    if (err.message?.includes('duplicate') || err.message?.includes('already exists')) {
      return res.status(409).json({ error: 'A restaurant or user with this email already exists.' });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
