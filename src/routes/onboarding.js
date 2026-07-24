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
const { ensureRestaurantSubscription, DEFAULT_SERVICES } = require('../helpers/subscriptionBilling');
const { writeAuditLog } = require('../helpers/auditLog');
const { sendOnboardingWelcomeEmail } = require('../helpers/onboardingEmail');

const DEFAULT_FEATURES = DEFAULT_SERVICES;

const { parseRegistrationLobType, REGISTER_LOB_TYPES } = require('../config/catalogSchemas');
const { completeEmbeddedSignupForRestaurant } = require('../helpers/embeddedSignupComplete');
const { slugify, selectDroppingMissingColumns } = require('./webcart/shared');
const { handleMenuUpload } = require('./catalog/menu-items');
const { buildTenantInsertFields } = require('../helpers/registrationPayload');
const {
  assertWhatsAppAssetsAvailable,
  recordRegistrationFailure,
  rollbackRegistration,
} = require('../helpers/registrationGuards');

/**
 * Registration's Step 4 catalog upload uses a simplified per-LOB column set
 * (RegistrationForm.jsx's LOB_CONFIGS — item_name/category/price/sku/...), which
 * is NOT the same as catalogSchemas.js's richer canonical bulk-upload template
 * (id/title/description/price/category/custom_label_0/...) used by the
 * authenticated Settings → Menu upload flow. Rather than a second, untested
 * insert pipeline, this adapter maps the simplified registration row onto the
 * same normalized shape handleMenuUpload() already expects, so first-catalog
 * seeding at signup reuses that one tested path.
 */
function adaptRegistrationCatalogRow(row, lobType) {
  const get = (key) => {
    const alt = key.replace(/_/g, ' ');
    return row[key] ?? row[key.toUpperCase()] ?? row[alt] ?? row[alt.replace(/\b\w/g, (c) => c.toUpperCase())] ?? '';
  };
  const str = (v) => String(v ?? '').trim();

  const name  = str(get('item_name') || get('name'));
  const sku   = str(get('sku'));
  const price = parseFloat(str(get('price')).replace(/[^0-9.]/g, '')) || 0;

  const item = {
    id:           sku || (name ? `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}` : null),
    name,
    description:  str(get('description')),
    price,
    category:     str(get('category')) || 'General',
    is_available: true,
  };

  if (lobType === 'restaurant') {
    const slot = str(get('slot')).toLowerCase();
    if (slot) item.time_slot = slot;
  } else if (lobType === 'food_products') {
    const shelfLife = str(get('shelf_life_days'));
    if (shelfLife) item.shelf_life_days = parseInt(shelfLife, 10) || null;
  } else if (lobType === 'retail') {
    // Also covers electronics/jewellery, aliased to 'retail' in catalogSchemas.js.
    const warrantyMonths = str(get('warranty_months'));
    if (warrantyMonths) item.warranty_days = (parseInt(warrantyMonths, 10) || 0) * 30;
    const material = str(get('material'));
    const stockQty = str(get('stock_qty'));
    if (stockQty) item.current_stock = parseInt(stockQty, 10) || null;
    if (material) item.description = [item.description, `Material: ${material}`].filter(Boolean).join(' — ');
  } else if (lobType === 'b2b') {
    // Aliased from 'supply' in catalogSchemas.js — no dedicated unit/MOQ columns,
    // so fold them into the description rather than invent unsupported fields.
    const unit = str(get('unit'));
    const moq  = str(get('moq'));
    const extra = [unit && `Unit: ${unit}`, moq && `MOQ: ${moq}`].filter(Boolean).join(' · ');
    if (extra) item.description = [item.description, extra].filter(Boolean).join(' — ');
  }

  return item;
}

/**
 * Runs the just-registered restaurant's Step 4 catalog upload through the same
 * insert pipeline the authenticated Settings → Menu upload uses, in-process
 * (no HTTP round-trip). Non-fatal: a bad catalog row should never fail
 * registration itself — the owner can always upload/fix the catalog later.
 */
async function seedCatalogFromRegistration(restaurantId, rawRows, lobType) {
  if (!Array.isArray(rawRows) || !rawRows.length) return null;

  const items = rawRows
    .map((row) => adaptRegistrationCatalogRow(row, lobType))
    .filter((item) => item.name && item.price > 0);
  if (!items.length) return { code: 400, payload: { error: 'No valid catalog rows found' } };

  const fakeReq = { user_role: 'owner', restaurant_id: restaurantId, body: { items } };
  let result = null;
  const fakeRes = {
    status(code) { this._code = code; return this; },
    json(payload) { result = { code: this._code || 200, payload }; return this; },
  };
  await handleMenuUpload(fakeReq, fakeRes);
  return result;
}
function resolveRegistrationLobType(body) {
  const raw = body?.lob_type ?? body?.org_type ?? body?.business_type ?? null;
  const parsed = parseRegistrationLobType(raw);
  if (parsed.invalid) {
    return {
      error: `Invalid lob_type "${parsed.attempted}". Allowed: ${REGISTER_LOB_TYPES.join(', ')} (aliases: supply→b2b, electronics/jewellery→retail)`,
    };
  }
  return { lob_type: parsed.lob_type };
}

// ── GET /slug-check/:slug ──────────────────────────────────────────────────────
// Also mounted at /api/v1/slug-check/:slug for the WordPress registration form
// (matches the fetch already in RegistrationForm.jsx's Step 1).
router.get('/slug-check/:slug', async (req, res) => {
  const candidate = slugify(req.params.slug || '');
  if (!candidate) {
    return res.status(400).json({ available: false, error: 'slug is required' });
  }

  // Prefer the persisted `slug` column (migrations/add_tenant_slug.sql). If that
  // migration hasn't run yet on this DB, selectDroppingMissingColumns retries
  // without it and we fall back to the same derived-slug check webcart/shared.js
  // uses at request time, so this endpoint works before and after the migration.
  const { data, error } = await selectDroppingMissingColumns(
    'slug-check',
    'id, slug, name, display_name',
    (select) => supabaseAdmin.from('tenants').select(select).eq('is_active', true).limit(2000),
  );
  if (error) {
    console.error('[onboarding] slug-check failed:', error.message);
    return res.status(500).json({ available: false, error: 'Could not check slug availability right now' });
  }

  const taken = (data || []).some((t) => {
    if (t.slug) return t.slug === candidate;
    return [slugify(t.display_name), slugify(t.name)].filter(Boolean).includes(candidate);
  });

  return res.json({ slug: candidate, available: !taken });
});

// ── POST /api/onboarding/register (+ /register/upload for WP multipart) ───────
// Also mounted at /api/v1/register for the WordPress registration form.

router.post(['/register', '/register/upload'], async (req, res) => {
  // Multipart signup: JSON payload may be in req.body.data
  if (req.body?.data && typeof req.body.data === 'string') {
    try {
      const parsed = JSON.parse(req.body.data);
      Object.assign(req.body, parsed);
    } catch (_) { /* ignore bad JSON */ }
  }

  const {
    // Core restaurant fields
    name,
    email,
    phone               = null,
    owner_name,
    owner_password,
    slug                = null,

    // WhatsApp
    whatsapp_number     = null,
    phone_number_id     = null,    // Meta phone_number_id for this outlet
    access_token        = null,    // WABA access token
    meta_access_token   = null,    // WP register form alias
    waba_id             = null,

    // Embedded Signup (from website Connect WhatsApp — no Meta Developer Console)
    embedded_signup_code = null,
    es_code              = null,
    display_phone_number = null,

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
  if (String(owner_password).length < 8) {
    return res.status(400).json({ error: 'owner_password must be at least 8 characters' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'email format is invalid' });
  }

  // FR-8: idempotency
  const idempotencyKey = req.get('Idempotency-Key') || req.body.idempotency_key || null;
  if (idempotencyKey) {
    const { data: cached } = await supabaseAdmin
      .from('registration_idempotency_keys')
      .select('response, status_code')
      .eq('idempotency_key', String(idempotencyKey).trim())
      .maybeSingle();
    if (cached?.response) {
      return res.status(cached.status_code || 201).json(cached.response);
    }
  }

  // Distinguish existing account vs new signup (FR-10 minimum)
  const emailNorm = email.trim().toLowerCase();
  const { data: existingEmp } = await supabaseAdmin
    .from('employees')
    .select('id, role')
    .eq('email', emailNorm)
    .maybeSingle();
  if (existingEmp) {
    return res.status(409).json({
      error: 'You already have an Autom8 account — log in and add a new business from your dashboard',
      code: 'existing_owner',
      login_url: (process.env.FRONTEND_URL || 'https://app.autom8.works').replace(/\/$/, '') + '/login',
    });
  }

  const lobResolved = resolveRegistrationLobType(req.body);
  if (lobResolved.error) return res.status(400).json({ error: lobResolved.error });
  const lob_type = lobResolved.lob_type;

  const resolvedAccessToken = access_token || meta_access_token || null;
  const esCode = (embedded_signup_code || es_code || '').trim() || null;
  const embeddedSignup = esCode ? {
    code: esCode,
    waba_id: waba_id || null,
    phone_number_id: phone_number_id || null,
    display_phone_number: display_phone_number || whatsapp_number || null,
  } : null;

  // When ES will finish Graph exchange, skip inserting a placeholder integration row
  const deferIntegration = Boolean(
    embeddedSignup?.code && embeddedSignup?.waba_id && embeddedSignup?.phone_number_id,
  );

  const isChain = !!chain_name?.trim();

  // ── CHAIN MODE ────────────────────────────────────────────────────────────
  if (isChain) {
    return registerChain(req, res, {
      chain_name, email, phone, owner_name, owner_password,
      waba_id, meta_business_id,
      first_outlet: {
        name, phone, whatsapp_number,
        phone_number_id: deferIntegration ? null : phone_number_id,
        access_token:    deferIntegration ? null : resolvedAccessToken,
        timezone, dining_duration_minutes, payment_mode, manager_phone,
        table_count, outlet_code, lob_type,
      },
      outlet_owner_email:    outlet_owner_email    || null,
      outlet_owner_name:     outlet_owner_name     || null,
      outlet_owner_password: outlet_owner_password || null,
      embeddedSignup,
    });
  }

  // ── STANDALONE MODE (existing behaviour, unchanged) ───────────────────────
  return registerStandalone(req, res, {
    name, email, phone, owner_name, owner_password, slug,
    whatsapp_number,
    phone_number_id: deferIntegration ? null : phone_number_id,
    access_token:    deferIntegration ? null : resolvedAccessToken,
    waba_id:         deferIntegration ? null : waba_id,
    timezone, dining_duration_minutes, payment_mode, manager_phone, table_count,
    meta_catalog_id, lob_type,
    embeddedSignup,
    idempotencyKey,
    display_name: req.body.display_name || null,
    city: req.body.city || null,
    country_code: req.body.country_code || null,
    currency_code: req.body.currency_code || null,
    address_line1: req.body.address_line1 || null,
    kitchen_workflow: req.body.kitchen_workflow || null,
    cuisines: req.body.cuisines || req.body.categories || null,
    slug: req.body.slug || null,
  });
});

// ── GET availability checks (FR-8) ───────────────────────────────────────────
router.get('/email-check/:email', async (req, res) => {
  try {
    const emailNorm = decodeURIComponent(req.params.email || '').trim().toLowerCase();
    if (!emailNorm || !emailNorm.includes('@')) {
      return res.status(400).json({ available: false, error: 'invalid email' });
    }
    const { data } = await supabaseAdmin
      .from('employees')
      .select('id')
      .eq('email', emailNorm)
      .maybeSingle();
    res.json({
      available: !data,
      code: data ? 'existing_owner' : null,
      message: data
        ? 'You already have an Autom8 account — log in instead'
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FR-6: checkpoint WhatsApp linkage by email before final submit
router.post('/draft', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required' });
    const draft = { ...(req.body.draft || {}) };
    delete draft.owner_password;
    delete draft.password;
    const row = {
      email,
      draft,
      waba_id: req.body.waba_id || draft.waba_id || null,
      phone_number_id: req.body.phone_number_id || draft.phone_number_id || null,
      whatsapp_number: req.body.whatsapp_number || draft.whatsapp_number || null,
      embedded_signup_code: req.body.embedded_signup_code || null,
      updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    const { data: existing } = await supabaseAdmin
      .from('registration_drafts')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    let saved;
    if (existing) {
      const { data, error } = await supabaseAdmin
        .from('registration_drafts').update(row).eq('id', existing.id).select().single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('registration_drafts').insert(row).select().single();
      if (error) throw error;
      saved = data;
    }
    res.json({ success: true, draft_id: saved.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/draft/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email || '').trim().toLowerCase();
    const { data } = await supabaseAdmin
      .from('registration_drafts')
      .select('id, draft, waba_id, phone_number_id, whatsapp_number, expires_at')
      .eq('email', email)
      .maybeSingle();
    if (!data) return res.json({ draft: null });
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      return res.json({ draft: null, expired: true });
    }
    res.json({
      draft_id: data.id,
      draft: data.draft,
      waba_id: data.waba_id,
      phone_number_id: data.phone_number_id,
      whatsapp_number: data.whatsapp_number,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// registerStandalone — original single-restaurant onboarding
// ─────────────────────────────────────────────────────────────────────────────

async function registerStandalone(req, res, opts) {
  const {
    name, email, phone, owner_name, owner_password,
    whatsapp_number, phone_number_id, access_token, waba_id,
    timezone, dining_duration_minutes, payment_mode, manager_phone, table_count,
    meta_catalog_id, lob_type,
    embeddedSignup = null,
    idempotencyKey = null,
    display_name = null,
    city = null,
    country_code = null,
    currency_code = null,
    address_line1 = null,
    kitchen_workflow = null,
    cuisines = null,
    slug = null,
  } = opts;

  let restaurantId = null;
  let authUserId   = null;

  // Resolve the slug: prefer what the user picked in Step 1 (already checked via
  // GET /slug-check/:slug), fall back to deriving one from name if they left it blank.
  const candidateSlug = slugify(slug || name || '');
  if (candidateSlug) {
    const { data: slugRows, error: slugCheckError } = await selectDroppingMissingColumns(
      'registerStandalone:slug-check',
      'id, slug, name, display_name',
      (select) => supabaseAdmin.from('tenants').select(select).eq('is_active', true).limit(2000),
    );
    if (slugCheckError) {
      return res.status(500).json({ error: 'Could not verify slug availability. Please try again.' });
    }
    const slugTaken = (slugRows || []).some((t) => {
      if (t.slug) return t.slug === candidateSlug;
      return [slugify(t.display_name), slugify(t.name)].filter(Boolean).includes(candidateSlug);
    });
    if (slugTaken) {
      return res.status(409).json({ error: `The slug "${candidateSlug}" is already in use. Please choose another.` });
    }
  }

  try {
    // Preflight WhatsApp uniqueness (FR-3)
    await assertWhatsAppAssetsAvailable({
      phone_number_id: embeddedSignup?.phone_number_id || phone_number_id,
      waba_id: embeddedSignup?.waba_id || waba_id,
      whatsapp_number: embeddedSignup?.display_phone_number || whatsapp_number,
    });

    const tenantRow = buildTenantInsertFields({
      name, email, phone, whatsapp_number, waba_id,
      timezone, dining_duration_minutes, payment_mode, manager_phone,
      meta_catalog_id, lob_type,
      display_name, city, country_code, currency_code, address_line1,
      kitchen_workflow, cuisines, slug: candidateSlug || slug,
      body: req.body,
    });

    // 1. Create restaurant row (full wizard fields + resilient optional columns)
    let restaurant;
    {
      let insertPayload = { ...tenantRow };
      if (candidateSlug) insertPayload.slug = candidateSlug;

      let { data, error: restError } = await supabaseAdmin
        .from('tenants')
        .insert(insertPayload)
        .select()
        .single();

      if (restError && /column .*slug.* does not exist|short_code|kitchen_workflow|opening_hours|country|cuisine/i.test(restError.message || '')) {
        console.warn('[onboarding] optional column missing — retrying stripped insert:', restError.message);
        const fallback = { ...insertPayload };
        delete fallback.slug;
        delete fallback.short_code;
        delete fallback.kitchen_workflow;
        delete fallback.country;
        ({ data, error: restError } = await supabaseAdmin
          .from('tenants')
          .insert(fallback)
          .select()
          .single());
      }

      if (restError && restError.code === '23505' && /slug/i.test(restError.message || '')) {
        return res.status(409).json({ error: `The slug "${candidateSlug}" was just taken. Please choose another.` });
      }
      if (restError) throw restError;
      restaurant = data;
    }    restaurantId = restaurant.id;

    // Paid plan (billing) — optional at signup; defaults to full trial access
    await ensureRestaurantSubscription(supabaseAdmin, restaurantId, {
      paidFeatures:    req.body.paid_features,
      enabledServices: req.body.enabled_services || restaurant.subscribed_features,
    });

    // 2. Create restaurant_integrations if phone_number_id provided (manual path)
    if (phone_number_id) {
      await supabaseAdmin.from('tenant_integrations').insert({
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
      await rollbackRegistration({
        restaurantId, email, slug, failedStep: 'auth_create', errorMessage: authError.message,
      });
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
    if (userError) {
      await rollbackRegistration({
        restaurantId, authUserId, email, slug, failedStep: 'employee_create', errorMessage: userError.message,
      });
      throw userError;
    }

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

    // 5b. Seed initial catalog from Step 4's upload, if provided (non-fatal).
    let catalogSeed = null;
    try {
      catalogSeed = await seedCatalogFromRegistration(restaurantId, req.body.menu_catalog, lob_type);
      if (catalogSeed && catalogSeed.code >= 400) {
        console.warn('[onboarding] Catalog seed had issues:', catalogSeed.payload);
      } else if (catalogSeed) {
        console.log(`[onboarding] ✅ Catalog seed: ${catalogSeed.payload?.upserted ?? 0} item(s) for ${restaurantId}`);
      }
    } catch (e) {
      console.warn('[onboarding] Catalog seed failed (non-fatal):', e.message);
    }

    // FR-9: B2B Supply → create suppliers row linked to same auth user
    let supplier = null;
    if (lob_type === 'b2b') {
      try {
        const { data: sup, error: supErr } = await supabaseAdmin.from('suppliers').insert({
          auth_user_id:  authUserId,
          name:          owner_name.trim(),
          business_name: (display_name || name).trim(),
          email:         email.trim().toLowerCase(),
          phone:         (whatsapp_number || phone || manager_phone || '').toString().replace(/\D/g, '') || '0000000000',
          city:          city || null,
          address:       address_line1 || null,
          lob_type:      'food_service',
          waba_phone:    whatsapp_number || null,
          waba_phone_number_id: embeddedSignup?.phone_number_id || phone_number_id || null,
          is_active:     true,
        }).select().single();
        if (supErr) throw supErr;
        supplier = sup;
      } catch (supCreateErr) {
        console.error('[onboarding] supplier create failed (non-fatal):', supCreateErr.message);
        await recordRegistrationFailure({
          email, slug, restaurant_id: restaurantId, auth_user_id: authUserId,
          failed_step: 'supplier_create', error_message: supCreateErr.message,
        });
      }
    }

    // 6. Audit    await writeAuditLog({
      user_id:       authUserId,
      restaurant_id: restaurantId,
      action:        'Restaurant registered (standalone)',
      details:       { name, email, whatsapp_number, lob_type, source: 'onboarding', catalog_seeded: catalogSeed?.payload?.upserted ?? 0 },
    });

    console.log(`[onboarding] ✅ Standalone: ${name} (${restaurantId}) — ${email} lob=${lob_type}`);

    let whatsapp = null;
    if (embeddedSignup?.code && embeddedSignup?.waba_id && embeddedSignup?.phone_number_id) {
      try {
        whatsapp = await completeEmbeddedSignupForRestaurant(restaurantId, {
          code: embeddedSignup.code,
          waba_id: embeddedSignup.waba_id,
          phone_number_id: embeddedSignup.phone_number_id,
          display_phone_number: embeddedSignup.display_phone_number || whatsapp_number,
          actorId: authUserId,
        });
        console.log(`[onboarding] ✅ Embedded Signup linked for ${restaurantId}`);
      } catch (esErr) {
        console.error('[onboarding] Embedded Signup failed (account created; connect later in Settings):', esErr.message);
        whatsapp = { success: false, error: esErr.message };
      }
    }

    // Welcome email — never fail registration if mail is down / missing address.
    sendOnboardingWelcomeEmail(restaurant).catch((e) =>
      console.error('[onboarding] welcome email failed (non-fatal):', e.message)
    );

    const loginUrl = (process.env.FRONTEND_URL || 'https://app.autom8.works').replace(/\/$/, '') + '/login';
    const waOk = !whatsapp || whatsapp.success !== false;
    const payload = {
      success:       true,
      status:        waOk ? 'ok' : 'needs_attention',
      mode:          'standalone',
      restaurant_id: restaurantId,
      user_id:       user.id,
      lob_type,
      supplier_id:   supplier?.id || null,
      region:        req.region?.region || process.env.REGION || 'IN',
      whatsapp,
      catalog_seed:  catalogSeed?.payload || null,
      login_url:     loginUrl,
      checkout_url:  loginUrl,
      message: waOk
        ? null
        : 'Your account is ready — WhatsApp could not be connected. Finish in Settings → WhatsApp.',
    };

    if (idempotencyKey) {
      await supabaseAdmin.from('registration_idempotency_keys').upsert({
        idempotency_key: String(idempotencyKey).trim(),
        email: email.trim().toLowerCase(),
        response: payload,
        status_code: 201,
      }).catch((e) => console.warn('[onboarding] idempotency store failed:', e.message));
    }

    // Clear draft after successful register
    await supabaseAdmin.from('registration_drafts')
      .delete()
      .eq('email', email.trim().toLowerCase())
      .catch(() => {});

    res.status(201).json(payload);

  } catch (err) {
    if (authUserId || restaurantId) {
      await rollbackRegistration({
        restaurantId, authUserId, email, slug,
        failedStep: 'registerStandalone',
        errorMessage: err.message,
      });
    }
    console.error('[onboarding/standalone]', err.message);
    if (err.status === 409 || err.code === 'whatsapp_number_taken' || err.code === 'waba_taken') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    if (err.message?.includes('duplicate') || err.message?.includes('already exists'))
      return res.status(409).json({
        error: 'A restaurant or user with this email already exists.',
        code: 'duplicate',
      });
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
    embeddedSignup = null,
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
        .from('tenants')
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
          lob_type:               first_outlet.lob_type      || 'restaurant',
          sort_order:             0,
          is_active:              true,
          subscribed_features:    DEFAULT_FEATURES,
        })
        .select()
        .single();
      if (restErr) throw restErr;
      restaurantId = restaurant.id;

      await ensureRestaurantSubscription(supabaseAdmin, restaurantId, {
        paidFeatures:    first_outlet.paid_features,
        enabledServices: first_outlet.enabled_services,
      });

      // Integration row for first outlet
      if (first_outlet.phone_number_id) {
        await supabaseAdmin.from('tenant_integrations').insert({
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
    await writeAuditLog({
      user_id:       authUserId,
      restaurant_id: restaurantId,
      action:        'Brand + first outlet registered',
      details:       { brand_id: brandId, chain_name, email, first_outlet: !!restaurantId },
    });

    console.log(`[onboarding] ✅ Chain: ${chain_name} (${brandId}) — owner: ${email}${restaurantId ? ` — outlet: ${restaurantId}` : ''}`);

    let whatsapp = null;
    if (
      restaurantId
      && embeddedSignup?.code
      && embeddedSignup?.waba_id
      && embeddedSignup?.phone_number_id
    ) {
      try {
        whatsapp = await completeEmbeddedSignupForRestaurant(restaurantId, {
          code: embeddedSignup.code,
          waba_id: embeddedSignup.waba_id,
          phone_number_id: embeddedSignup.phone_number_id,
          display_phone_number: embeddedSignup.display_phone_number || first_outlet?.whatsapp_number,
          actorId: authUserId,
        });
      } catch (esErr) {
        console.error('[onboarding/chain] Embedded Signup failed:', esErr.message);
        whatsapp = { success: false, error: esErr.message };
      }
    }

    if (restaurantId) {
      const { data: outletRow } = await supabaseAdmin
        .from('tenants')
        .select('id, name, contact_email, email')
        .eq('id', restaurantId)
        .maybeSingle();
      if (outletRow) {
        sendOnboardingWelcomeEmail({
          ...outletRow,
          // Prefer brand contact email when outlet row has an internal placeholder.
          email: (outlet_owner_email || email || outletRow.email || '').trim(),
          contact_email: outletRow.contact_email || outlet_owner_email || email || null,
        }).catch((e) =>
          console.error('[onboarding/chain] welcome email failed (non-fatal):', e.message)
        );
      }
    }

    const loginUrl = (process.env.FRONTEND_URL || 'https://app.autom8.works').replace(/\/$/, '') + '/login';

    res.status(201).json({
      success:         true,
      mode:            'chain',
      brand_id:        brandId,
      user_id:         authUserId,
      restaurant_id:   restaurantId,
      outlet_owner_id: outletOwnerId,
      region:          req.region?.region || process.env.REGION || 'IN',
      whatsapp,
      login_url:       loginUrl,
      checkout_url:    loginUrl,
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
