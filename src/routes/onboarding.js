// src/routes/onboarding.js
// Handles: restaurant registration + default user creation
//
// Two modes:
//   Standalone (default) — single restaurant, one owner
//   Chain mode          — triggered when chain_name is provided
//                         Creates brands row + first outlet + brand_owner + outlet owner

'use strict';

const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../config/supabase');

const DEFAULT_FEATURES = ['dine_in', 'takeaway', 'delivery', 'reserve_table'];

// ── POST /api/onboarding/register ─────────────────────────────────────────────

router.post('/register', async (req, res) => {
  const {
    // Core restaurant fields
    name,
    email,
    phone               = null,
    owner_name,
    owner_password,

    // WhatsApp
    whatsapp_number     = null,
    phone_number_id     = null,    // Meta phone_number_id for this outlet
    access_token        = null,    // WABA access token
    waba_id             = null,

    // Optional settings
    timezone             = 'Asia/Kolkata',
    dining_duration_minutes = 90,
    payment_mode         = 'prepay',
    manager_phone        = null,
    meta_catalog_id      = null,
    table_count          = 0,

    // ── Chain mode (new) ──────────────────────────────────────────────────────
    // Providing chain_name triggers chain mode:
    //   - Creates a brands row (the parent entity)
    //   - Creates a brand_owner employee (no restaurant_id)
    //   - Creates the outlet as the first restaurant under the brand
    //   - Creates a separate outlet-level owner (if outlet_owner_email provided)
    chain_name           = null,
    meta_business_id     = null,
    outlet_code          = null,
    outlet_owner_email   = null,   // Optional separate outlet owner (defaults to email if omitted)
    outlet_owner_name    = null,
    outlet_owner_password = null,
  } = req.body;

  if (!name?.trim())          return res.status(400).json({ error: 'name is required' });
  if (!email?.trim())         return res.status(400).json({ error: 'email is required' });
  if (!owner_name?.trim())    return res.status(400).json({ error: 'owner_name is required' });
  if (!owner_password)        return res.status(400).json({ error: 'owner_password is required' });

  const isChain = !!chain_name?.trim();

  // ── CHAIN MODE ────────────────────────────────────────────────────────────
  if (isChain) {
    return registerChain(req, res, {
      chain_name, email, phone, owner_name, owner_password,
      waba_id, meta_business_id,
      first_outlet: {
        name, phone, whatsapp_number, phone_number_id, access_token,
        timezone, dining_duration_minutes, payment_mode, manager_phone,
        table_count, outlet_code,
      },
      outlet_owner_email:    outlet_owner_email    || null,
      outlet_owner_name:     outlet_owner_name     || null,
      outlet_owner_password: outlet_owner_password || null,
    });
  }

  // ── STANDALONE MODE (existing behaviour, unchanged) ───────────────────────
  return registerStandalone(req, res, {
    name, email, phone, owner_name, owner_password,
    whatsapp_number, phone_number_id, access_token, waba_id,
    timezone, dining_duration_minutes, payment_mode, manager_phone, table_count,
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// registerStandalone — original single-restaurant onboarding
// ─────────────────────────────────────────────────────────────────────────────

async function registerStandalone(req, res, opts) {
  const {
    name, email, phone, owner_name, owner_password,
    whatsapp_number, phone_number_id, access_token, waba_id,
    timezone, dining_duration_minutes, payment_mode, manager_phone, table_count,
  } = opts;

  let restaurantId = null;
  let authUserId   = null;

  try {
    // 1. Create restaurant row
    const { data: restaurant, error: restError } = await supabaseAdmin
      .from('restaurants')
      .insert({
        name,
        email:                  email.trim().toLowerCase(),
        phone:                  phone            || null,
        whatsapp_number:        whatsapp_number  || null,
        waba_id:                waba_id          || null,
        timezone,
        dining_duration_minutes,
        payment_mode,
        manager_phone:          manager_phone    || null,
        meta_catalog_id:        meta_catalog_id  || null,
        is_active:              true,
        subscribed_features:    DEFAULT_FEATURES,
      })
      .select()
      .single();
    if (restError) throw restError;
    restaurantId = restaurant.id;

    // 2. Create restaurant_integrations if phone_number_id provided
    if (phone_number_id) {
      await supabaseAdmin.from('restaurant_integrations').insert({
        restaurant_id:   restaurantId,
        provider:        'meta',
        channel:         'whatsapp',
        phone_number_id: phone_number_id,
        access_token:    access_token || null,
        is_active:       true,
      }).catch(e => console.warn('[onboarding] Integration insert failed (non-fatal):', e.message));
    }

    // 3. Create Supabase Auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email:         email.trim().toLowerCase(),
      password:      owner_password,
      email_confirm: true,
    });
    if (authError) {
      await supabaseAdmin.from('restaurants').delete().eq('id', restaurantId);
      throw authError;
    }
    authUserId = authData.user.id;

    // 4. Create employees row (outlet owner)
    const { data: user, error: userError } = await supabaseAdmin
      .from('employees')
      .insert({
        id:            authUserId,
        restaurant_id: restaurantId,
        email:         email.trim().toLowerCase(),
        full_name:     owner_name.trim(),
        phone:         phone || null,
        role:          'owner',
        is_active:     true,
        hired_at:      new Date().toISOString(),
      })
      .select()
      .single();
    if (userError) throw userError;

    // 5. Auto-create tables
    const count = parseInt(table_count) || 0;
    if (count > 0) {
      const tableRows = Array.from({ length: count }, (_, i) => ({
        restaurant_id: restaurantId,
        table_number:  i + 1,
        capacity:      4,
        status:        'available',
        is_active:     true,
      }));
      await supabaseAdmin.from('tables').insert(tableRows)
        .catch(e => console.warn('[onboarding] Table creation failed (non-fatal):', e.message));
    }

    // 6. Audit
    await supabaseAdmin.from('audit_logs').insert({
      user_id:       authUserId,
      restaurant_id: restaurantId,
      action:        'Restaurant registered (standalone)',
      details:       { name, email, whatsapp_number, source: 'onboarding' },
    }).catch(() => {});

    console.log(`[onboarding] ✅ Standalone: ${name} (${restaurantId}) — ${email}`);

    res.status(201).json({
      success:       true,
      mode:          'standalone',
      restaurant_id: restaurantId,
      user_id:       user.id,
      region:        req.region?.region || process.env.REGION || 'IN',
    });

  } catch (err) {
    if (authUserId)    supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => {});
    if (restaurantId)  supabaseAdmin.from('restaurants').delete().eq('id', restaurantId).catch(() => {});
    console.error('[onboarding/standalone]', err.message);
    if (err.message?.includes('duplicate') || err.message?.includes('already exists'))
      return res.status(409).json({ error: 'A restaurant or user with this email already exists.' });
    res.status(500).json({ error: err.message });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// registerChain — creates brand + brand_owner + first outlet
// ─────────────────────────────────────────────────────────────────────────────

async function registerChain(req, res, opts) {
  const {
    chain_name, email, phone, owner_name, owner_password,
    waba_id, meta_business_id,
    first_outlet,
    outlet_owner_email, outlet_owner_name, outlet_owner_password,
  } = opts;

  let brandId    = null;
  let authUserId = null;

  try {
    // 1. Create brands row
    const { data: brand, error: brandErr } = await supabaseAdmin
      .from('brands')
      .insert({
        name:             chain_name.trim(),
        contact_email:    email.trim().toLowerCase(),
        contact_phone:    phone            || null,
        waba_id:          waba_id          || null,
        meta_business_id: meta_business_id || null,
        plan:             'chain',
        is_active:        true,
      })
      .select()
      .single();
    if (brandErr) throw brandErr;
    brandId = brand.id;

    // 2. Create Supabase Auth user for brand_owner
    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email:         email.trim().toLowerCase(),
      password:      owner_password,
      email_confirm: true,
    });
    if (authErr) {
      await supabaseAdmin.from('brands').delete().eq('id', brandId);
      throw authErr;
    }
    authUserId = authData.user.id;

    // 3. Create brand_owner employee (no restaurant_id)
    const { error: empErr } = await supabaseAdmin.from('employees').insert({
      id:            authUserId,
      brand_id:      brandId,
      restaurant_id: null,
      email:         email.trim().toLowerCase(),
      full_name:     owner_name.trim(),
      phone:         phone || null,
      role:          'brand_owner',
      is_active:     true,
      hired_at:      new Date().toISOString(),
    });
    if (empErr) throw empErr;

    // 4. Create first outlet
    let restaurantId  = null;
    let outletOwnerId = null;

    if (first_outlet?.name) {
      const { data: restaurant, error: restErr } = await supabaseAdmin
        .from('restaurants')
        .insert({
          brand_id:               brandId,
          name:                   first_outlet.name.trim(),
          email:                  outlet_owner_email?.trim().toLowerCase()
                                    || `outlet-1@brand-${brandId}.internal`,
          phone:                  first_outlet.phone        || null,
          whatsapp_number:        first_outlet.whatsapp_number || null,
          waba_id:                waba_id                   || null,
          timezone:               first_outlet.timezone     || 'Asia/Kolkata',
          dining_duration_minutes: first_outlet.dining_duration_minutes || 90,
          payment_mode:           first_outlet.payment_mode || 'prepay',
          manager_phone:          first_outlet.manager_phone || null,
          outlet_code:            first_outlet.outlet_code   || null,
          sort_order:             0,
          is_active:              true,
          subscribed_features:    DEFAULT_FEATURES,
        })
        .select()
        .single();
      if (restErr) throw restErr;
      restaurantId = restaurant.id;

      // Integration row for first outlet
      if (first_outlet.phone_number_id) {
        await supabaseAdmin.from('restaurant_integrations').insert({
          restaurant_id:   restaurantId,
          provider:        'meta',
          channel:         'whatsapp',
          phone_number_id: first_outlet.phone_number_id,
          access_token:    first_outlet.access_token || null,
          is_active:       true,
        }).catch(e => console.warn('[onboarding/chain] Integration insert failed:', e.message));
      }

      // Auto-create tables
      const tableCount = parseInt(first_outlet.table_count) || 0;
      if (tableCount > 0) {
        const rows = Array.from({ length: tableCount }, (_, i) => ({
          restaurant_id: restaurantId, table_number: i + 1,
          capacity: 4, status: 'available', is_active: true,
        }));
        await supabaseAdmin.from('tables').insert(rows)
          .catch(e => console.warn('[onboarding/chain] Tables insert failed:', e.message));
      }

      // Optional: separate outlet-level owner
      if (outlet_owner_email && outlet_owner_name && outlet_owner_password) {
        try {
          const { data: outletAuth } = await supabaseAdmin.auth.admin.createUser({
            email: outlet_owner_email.trim().toLowerCase(),
            password: outlet_owner_password,
            email_confirm: true,
          });
          if (outletAuth?.user) {
            await supabaseAdmin.from('employees').insert({
              id:            outletAuth.user.id,
              restaurant_id: restaurantId,
              brand_id:      brandId,
              email:         outlet_owner_email.trim().toLowerCase(),
              full_name:     outlet_owner_name.trim(),
              role:          'owner',
              is_active:     true,
              hired_at:      new Date().toISOString(),
            });
            outletOwnerId = outletAuth.user.id;
          }
        } catch (ownerErr) {
          console.warn('[onboarding/chain] Outlet owner creation failed (non-fatal):', ownerErr.message);
        }
      }
    }

    // 5. Audit
    await supabaseAdmin.from('audit_logs').insert({
      user_id:       authUserId,
      restaurant_id: restaurantId,
      action:        'Brand + first outlet registered',
      details:       { brand_id: brandId, chain_name, email, first_outlet: !!restaurantId },
    }).catch(() => {});

    console.log(`[onboarding] ✅ Chain: ${chain_name} (${brandId}) — owner: ${email}${restaurantId ? ` — outlet: ${restaurantId}` : ''}`);

    res.status(201).json({
      success:         true,
      mode:            'chain',
      brand_id:        brandId,
      user_id:         authUserId,
      restaurant_id:   restaurantId,
      outlet_owner_id: outletOwnerId,
      region:          req.region?.region || process.env.REGION || 'IN',
    });

  } catch (err) {
    if (authUserId) supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => {});
    if (brandId)    supabaseAdmin.from('brands').delete().eq('id', brandId).catch(() => {});
    console.error('[onboarding/chain]', err.message);
    if (err.message?.includes('duplicate') || err.message?.includes('already exists'))
      return res.status(409).json({ error: 'A brand or user with this email already exists.' });
    res.status(500).json({ error: err.message });
  }
}

module.exports = router;
