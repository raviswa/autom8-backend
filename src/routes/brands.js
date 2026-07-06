// src/routes/brands.js
// ============================================================================
// Brand / Chain Management
//
// A Brand is the parent entity that owns multiple restaurant outlets.
// Brand employees (brand_owner, brand_manager) have restaurant_id = NULL
// and can access all outlets under the brand.
//
// Public endpoints (no auth):
//   POST   /api/brands                     — Create brand + brand_owner (registration)
//
// Brand-authenticated endpoints:
//   GET    /api/brands/:id                 — Brand details + outlet summary
//   PUT    /api/brands/:id                 — Update brand (owner only)
//   GET    /api/brands/:id/outlets         — List all outlets with live KPIs
//   POST   /api/brands/:id/outlets         — Add new outlet (owner only)
//   PUT    /api/brands/:id/outlets/:oid    — Update outlet settings (owner only)
//   DELETE /api/brands/:id/outlets/:oid    — Deactivate outlet (owner only)
//   GET    /api/brands/:id/dashboard       — Aggregate KPIs across all outlets
//   POST   /api/brands/:id/menu/push       — Push brand master menu to outlets (owner only)
//   POST   /api/brands/:id/campaigns/send  — Cross-outlet broadcast campaign
// ============================================================================

'use strict';

const express        = require('express');
const router         = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');
const { invalidatePhoneCache } = require('../helpers/resolveRestaurant');
const { ensureRestaurantSubscription } = require('../helpers/subscriptionBilling');
const { writeAuditLog } = require('../helpers/auditLog');

const BRAND_ROLES       = ['brand_owner', 'brand_manager'];
const DEFAULT_FEATURES  = ['dine_in', 'takeaway', 'delivery', 'reserve_table'];

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function getBrandEmployee(userId) {
  const { data, error } = await supabaseAdmin
    .from('employees')
    .select('id, role, brand_id, restaurant_id, is_active, full_name')
    .eq('id', userId)
    .single();

  if (error || !data) throw Object.assign(new Error('Employee not found'), { status: 401 });
  if (!data.is_active) throw Object.assign(new Error('Account deactivated'), { status: 403 });
  return data;
}

function assertBrandRole(emp, brandId, ownerOnly = false) {
  if (!BRAND_ROLES.includes(emp.role))
    throw Object.assign(new Error('Brand-level access required'), { status: 403 });
  if (ownerOnly && emp.role !== 'brand_owner')
    throw Object.assign(new Error('Brand owner access required'), { status: 403 });
  if (emp.brand_id !== brandId)
    throw Object.assign(new Error('Access denied to this brand'), { status: 403 });
}

function handleErr(res, err) {
  const status = err.status ?? 500;
  console.error(`[brands] ${err.message}`);
  res.status(status).json({ error: err.message });
}


// ── POST /api/brands — Create brand + brand_owner (public, from registration) ─

router.post('/', async (req, res) => {
  const {
    brand_name,
    contact_email,
    contact_phone    = null,
    legal_name       = null,
    waba_id          = null,
    meta_business_id = null,
    owner_name,
    owner_password,
    first_outlet     = null,  // optional: { name, address, outlet_code, whatsapp_number, phone_number_id, access_token, table_count }
  } = req.body;

  if (!brand_name?.trim())   return res.status(400).json({ error: 'brand_name is required' });
  if (!contact_email?.trim()) return res.status(400).json({ error: 'contact_email is required' });
  if (!owner_name?.trim())   return res.status(400).json({ error: 'owner_name is required' });
  if (!owner_password)       return res.status(400).json({ error: 'owner_password is required' });

  let brandId       = null;
  let authUserId    = null;
  let firstOutletId = null;

  try {
    // 1 ── Create brand row
    const { data: brand, error: brandErr } = await supabaseAdmin
      .from('brands')
      .insert({
        name:             brand_name.trim(),
        legal_name:       legal_name   || null,
        contact_email:    contact_email.trim().toLowerCase(),
        contact_phone:    contact_phone || null,
        waba_id:          waba_id       || null,
        meta_business_id: meta_business_id || null,
        plan:             'chain',
        is_active:        true,
      })
      .select()
      .single();

    if (brandErr) {
      if (brandErr.message?.includes('duplicate') || brandErr.message?.includes('unique'))
        return res.status(409).json({ error: 'A brand with this email already exists.' });
      throw brandErr;
    }
    brandId = brand.id;

    // 2 ── Create Supabase Auth user for brand_owner
    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email:         contact_email.trim().toLowerCase(),
      password:      owner_password,
      email_confirm: true,
    });

    if (authErr) {
      await supabaseAdmin.from('brands').delete().eq('id', brandId);
      if (authErr.message?.includes('already'))
        return res.status(409).json({ error: 'A user with this email already exists.' });
      throw authErr;
    }
    authUserId = authData.user.id;

    // 3 ── Create brand_owner employee (no restaurant_id)
    const { error: empErr } = await supabaseAdmin.from('employees').insert({
      id:              authUserId,
      brand_id:        brandId,
      restaurant_id:   null,
      email:           contact_email.trim().toLowerCase(),
      full_name:       owner_name.trim(),
      phone:           contact_phone || null,
      role:            'brand_owner',
      is_active:       true,
      hired_at:        new Date().toISOString(),
    });

    if (empErr) {
      await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => {});
      await supabaseAdmin.from('brands').delete().eq('id', brandId);
      throw empErr;
    }

    // 4 ── Create first outlet (optional)
    if (first_outlet?.name) {
      const outletResult = await createOutlet(brandId, first_outlet);
      firstOutletId = outletResult.restaurant_id;
    }

    // 5 ── Audit
    await writeAuditLog({
      user_id:       authUserId,
      restaurant_id: firstOutletId,
      action:        'Brand registered',
      details:       { brand_id: brandId, brand_name, contact_email, first_outlet: !!firstOutletId },
    });

    console.log(`[brands] ✅ Created: ${brand_name} (${brandId}) — owner: ${contact_email}`);

    res.status(201).json({
      success:         true,
      brand_id:        brandId,
      user_id:         authUserId,
      first_outlet_id: firstOutletId,
    });

  } catch (err) {
    // Best-effort rollback of partially-created data
    if (authUserId) supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => {});
    if (brandId)    supabaseAdmin.from('brands').delete().eq('id', brandId).catch(() => {});
    handleErr(res, err);
  }
});


// ── GET /api/brands/:id — Brand details ──────────────────────────────────────

router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const emp = await getBrandEmployee(req.user.sub);
    assertBrandRole(emp, req.params.id);

    const { data: brand, error } = await supabaseAdmin
      .from('brands')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !brand) return res.status(404).json({ error: 'Brand not found' });

    const { count: outletCount } = await supabaseAdmin
      .from('tenants')
      .select('id', { count: 'exact', head: true })
      .eq('brand_id', req.params.id)
      .eq('is_active', true);

    res.json({ success: true, brand: { ...brand, outlet_count: outletCount ?? 0 } });
  } catch (err) { handleErr(res, err); }
});


// ── PUT /api/brands/:id — Update brand ───────────────────────────────────────

router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const emp = await getBrandEmployee(req.user.sub);
    assertBrandRole(emp, req.params.id, /* ownerOnly */ true);

    const allowed = ['name', 'legal_name', 'logo_url', 'contact_phone',
                     'waba_id', 'meta_business_id', 'plan'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('brands')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    // If WABA ID changed, the phone_number_id cache is still valid
    // (phone_number_id → restaurant_id mapping hasn't changed)

    res.json({ success: true, brand: data });
  } catch (err) { handleErr(res, err); }
});


// ── GET /api/brands/:id/outlets — List all outlets ───────────────────────────

router.get('/:id/outlets', authenticateToken, async (req, res) => {
  try {
    const emp = await getBrandEmployee(req.user.sub);
    assertBrandRole(emp, req.params.id);

    const { data: outlets, error } = await supabaseAdmin
      .from('tenants')
      .select(`
        id, name, outlet_code, sort_order, city, address,
        whatsapp_number, manager_phone, timezone, is_active,
        subscribed_features, created_at
      `)
      .eq('brand_id', req.params.id)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Attach today's quick KPIs (order count + revenue) for each outlet
    const today    = new Date().toISOString().split('T')[0];
    const ids      = (outlets ?? []).map(o => o.id);

    const { data: orders } = ids.length ? await supabaseAdmin
      .from('orders')
      .select('restaurant_id, total_amount, status')
      .in('restaurant_id', ids)
      .in('status', ['confirmed', 'completed'])
      .gte('created_at', `${today}T00:00:00.000Z`) : { data: [] };

    const kpiMap = {};
    for (const o of orders ?? []) {
      if (!kpiMap[o.restaurant_id]) kpiMap[o.restaurant_id] = { orders: 0, revenue: 0 };
      kpiMap[o.restaurant_id].orders  += 1;
      kpiMap[o.restaurant_id].revenue += Number(o.total_amount ?? 0);
    }

    const enriched = (outlets ?? []).map(outlet => ({
      ...outlet,
      today_orders:  kpiMap[outlet.id]?.orders  ?? 0,
      today_revenue: kpiMap[outlet.id]?.revenue ?? 0,
    }));

    res.json({ success: true, outlets: enriched });
  } catch (err) { handleErr(res, err); }
});


// ── POST /api/brands/:id/outlets — Add new outlet ────────────────────────────

router.post('/:id/outlets', authenticateToken, async (req, res) => {
  try {
    const emp = await getBrandEmployee(req.user.sub);
    assertBrandRole(emp, req.params.id, /* ownerOnly */ true);

    const outletData = req.body;
    if (!outletData.name?.trim())
      return res.status(400).json({ error: 'Outlet name is required' });

    const result = await createOutlet(req.params.id, outletData);

    await writeAuditLog({
      user_id:       req.user.sub,
      restaurant_id: result.restaurant_id,
      action:        'Outlet added to brand',
      details:       { brand_id: req.params.id, outlet_name: outletData.name },
    });

    res.status(201).json({ success: true, ...result });
  } catch (err) { handleErr(res, err); }
});


// ── PUT /api/brands/:id/outlets/:oid — Update outlet ─────────────────────────

router.put('/:id/outlets/:oid', authenticateToken, async (req, res) => {
  try {
    const emp = await getBrandEmployee(req.user.sub);
    assertBrandRole(emp, req.params.id, /* ownerOnly */ true);

    // Confirm outlet belongs to this brand
    const { data: outlet } = await supabaseAdmin
      .from('tenants')
      .select('id, brand_id')
      .eq('id', req.params.oid)
      .eq('brand_id', req.params.id)
      .single();

    if (!outlet) return res.status(404).json({ error: 'Outlet not found in this brand' });

    const allowed = ['name', 'outlet_code', 'sort_order', 'address', 'city',
                     'whatsapp_number', 'manager_phone', 'timezone',
                     'dining_duration_minutes', 'payment_mode', 'subscribed_features'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('tenants')
      .update(updates)
      .eq('id', req.params.oid)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, outlet: data });
  } catch (err) { handleErr(res, err); }
});


// ── DELETE /api/brands/:id/outlets/:oid — Deactivate outlet ──────────────────

router.delete('/:id/outlets/:oid', authenticateToken, async (req, res) => {
  try {
    const emp = await getBrandEmployee(req.user.sub);
    assertBrandRole(emp, req.params.id, /* ownerOnly */ true);

    const { data: outlet } = await supabaseAdmin
      .from('tenants').select('id, name, brand_id').eq('id', req.params.oid).eq('brand_id', req.params.id).single();
    if (!outlet) return res.status(404).json({ error: 'Outlet not found in this brand' });

    // Count active outlets — prevent deactivating the last one
    const { count } = await supabaseAdmin
      .from('tenants').select('id', { count: 'exact', head: true })
      .eq('brand_id', req.params.id).eq('is_active', true);

    if ((count ?? 0) <= 1)
      return res.status(400).json({ error: 'Cannot deactivate the last active outlet.' });

    await supabaseAdmin.from('tenants')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.oid);

    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: req.params.oid,
      action: 'Outlet deactivated', details: { brand_id: req.params.id, outlet_name: outlet.name },
    });

    res.json({ success: true, message: `Outlet "${outlet.name}" deactivated.` });
  } catch (err) { handleErr(res, err); }
});


// ── GET /api/brands/:id/dashboard — Aggregate KPIs ───────────────────────────

router.get('/:id/dashboard', authenticateToken, async (req, res) => {
  try {
    const emp = await getBrandEmployee(req.user.sub);
    assertBrandRole(emp, req.params.id);

    const date       = req.query.date ?? new Date().toISOString().split('T')[0];
    const start      = `${date}T00:00:00.000Z`;
    const end        = `${date}T23:59:59.999Z`;

    // All active outlet IDs under this brand
    const { data: outletRows } = await supabaseAdmin
      .from('tenants')
      .select('id, name, outlet_code')
      .eq('brand_id', req.params.id)
      .eq('is_active', true);

    const outlets        = outletRows ?? [];
    const outletIds      = outlets.map(o => o.id);
    const outletNameMap  = Object.fromEntries(outlets.map(o => [o.id, o.name]));

    if (!outletIds.length)
      return res.json({ success: true, outlets: [], summary: { total_revenue: 0 }, revenue_by_outlet: {} });

    // Orders for the day
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('restaurant_id, total_amount, status')
      .in('restaurant_id', outletIds)
      .in('status', ['confirmed', 'completed'])
      .gte('created_at', start)
      .lte('created_at', end);

    const revenueByOutlet = {};
    let totalRevenue = 0;
    for (const order of orders ?? []) {
      const rid = order.restaurant_id;
      revenueByOutlet[rid] = (revenueByOutlet[rid] ?? 0) + Number(order.total_amount ?? 0);
      totalRevenue += Number(order.total_amount ?? 0);
    }

    // Top outlet
    let topOutletId = null, topOutletRev = 0;
    for (const [id, rev] of Object.entries(revenueByOutlet)) {
      if (rev > topOutletRev) { topOutletRev = rev; topOutletId = id; }
    }

    // Top menu item across all outlets
    const { data: topItems } = await supabaseAdmin
      .from('order_items')
      .select('quantity, menu_item:menu_item_id(name, restaurant_id)')
      .in('menu_item.restaurant_id', outletIds);

    const itemQty = {};
    for (const oi of topItems ?? []) {
      const name = oi.menu_item?.name ?? 'Unknown';
      itemQty[name] = (itemQty[name] ?? 0) + (oi.quantity ?? 1);
    }
    const topItem = Object.entries(itemQty).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';

    // RFM at-risk: customers who ordered before 14 days ago but not since
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: oldOrders } = await supabaseAdmin
      .from('orders').select('customer_phone').in('restaurant_id', outletIds)
      .eq('status', 'completed').lt('created_at', fourteenDaysAgo);
    const { data: recentOrders } = await supabaseAdmin
      .from('orders').select('customer_phone').in('restaurant_id', outletIds)
      .eq('status', 'completed').gte('created_at', fourteenDaysAgo);

    const atRiskSet    = new Set((oldOrders    ?? []).map(o => o.customer_phone).filter(Boolean));
    const recentSet    = new Set((recentOrders ?? []).map(o => o.customer_phone).filter(Boolean));
    for (const p of recentSet) atRiskSet.delete(p);

    res.json({
      success:    true,
      date,
      outlets:    outlets.map(o => ({
        id:            o.id,
        name:          o.name,
        outlet_code:   o.outlet_code,
        today_revenue: parseFloat((revenueByOutlet[o.id] ?? 0).toFixed(2)),
        today_orders:  (orders ?? []).filter(ord => ord.restaurant_id === o.id).length,
      })),
      summary: {
        total_revenue:      parseFloat(totalRevenue.toFixed(2)),
        top_outlet_name:    topOutletId ? outletNameMap[topOutletId] : '—',
        top_outlet_revenue: parseFloat(topOutletRev.toFixed(2)),
        top_item:           topItem,
        rfm_at_risk_count:  atRiskSet.size,
      },
      revenue_by_outlet: Object.fromEntries(
        Object.entries(revenueByOutlet).map(([id, rev]) => [
          outletNameMap[id] ?? id,
          parseFloat(rev.toFixed(2)),
        ])
      ),
    });
  } catch (err) { handleErr(res, err); }
});


// ── POST /api/brands/:id/menu/push — Push brand master menu to outlets ────────
//
// Brand items with meta_product_id = 'brand:{brand_item_id}' are tracked.
// Items with brand_override != NULL are skipped (outlet has customised them).

router.post('/:id/menu/push', authenticateToken, async (req, res) => {
  try {
    const emp = await getBrandEmployee(req.user.sub);
    assertBrandRole(emp, req.params.id, /* ownerOnly */ true);

    const { outlet_ids = 'all' } = req.body;

    // Fetch brand master menu
    const { data: brandItems, error: biErr } = await supabaseAdmin
      .from('brand_menu_items')
      .select('*')
      .eq('brand_id', req.params.id)
      .eq('is_active', true);

    if (biErr) throw biErr;
    if (!brandItems?.length) return res.json({ success: true, message: 'Brand menu is empty. Add items first.', pushed: 0 });

    // Determine target outlets
    let targetIds = [];
    if (outlet_ids === 'all') {
      const { data: outlets } = await supabaseAdmin
        .from('tenants').select('id').eq('brand_id', req.params.id).eq('is_active', true);
      targetIds = (outlets ?? []).map(o => o.id);
    } else {
      targetIds = Array.isArray(outlet_ids) ? outlet_ids : [outlet_ids];
    }

    if (!targetIds.length) return res.json({ success: true, message: 'No target outlets found.', pushed: 0 });

    let insertedTotal = 0;
    let updatedTotal  = 0;
    let skippedTotal  = 0;

    for (const outletId of targetIds) {
      // Fetch existing menu items for this outlet that came from brand
      const { data: existing } = await supabaseAdmin
        .from('menu_items').select('id, meta_product_id, brand_override')
        .eq('restaurant_id', outletId);

      // Build lookup: brand_item_id → existing outlet item
      const brandItemMap = {};
      for (const item of existing ?? []) {
        if (item.meta_product_id?.startsWith('brand:')) {
          const brandItemId = item.meta_product_id.replace('brand:', '');
          brandItemMap[brandItemId] = item;
        }
      }

      for (const brandItem of brandItems) {
        const existingItem = brandItemMap[brandItem.id];

        if (existingItem) {
          // Skip if outlet has a custom override
          if (existingItem.brand_override !== null) { skippedTotal++; continue; }

          // Update with latest brand values
          await supabaseAdmin.from('menu_items').update({
            name:        brandItem.name,
            description: brandItem.description,
            category:    brandItem.category,
            price:       brandItem.base_price,
            image_url:   brandItem.image_url,
            time_slot:   brandItem.time_slot,
            is_available: brandItem.is_active,
            updated_at:  new Date().toISOString(),
          }).eq('id', existingItem.id);
          updatedTotal++;
        } else {
          // Insert new item
          await supabaseAdmin.from('menu_items').insert({
            restaurant_id:    outletId,
            name:             brandItem.name,
            description:      brandItem.description,
            category:         brandItem.category,
            price:            brandItem.base_price,
            image_url:        brandItem.image_url,
            time_slot:        brandItem.time_slot,
            is_available:     brandItem.is_active,
            meta_product_id:  `brand:${brandItem.id}`,  // tracks provenance
            brand_override:   null,                      // null = using brand defaults
          });
          insertedTotal++;
        }
      }
    }

    res.json({
      success: true,
      pushed_to_outlets: targetIds.length,
      inserted: insertedTotal,
      updated:  updatedTotal,
      skipped:  skippedTotal, // items with outlet overrides
    });
  } catch (err) { handleErr(res, err); }
});


// ── POST /api/brands/:id/campaigns/send — Cross-outlet broadcast ──────────────

router.post('/:id/campaigns/send', authenticateToken, async (req, res) => {
  try {
    const emp = await getBrandEmployee(req.user.sub);
    assertBrandRole(emp, req.params.id);

    const { name, segment = 'all', message, template_name = null, outlet_ids = 'all' } = req.body;
    if (!name?.trim())    return res.status(400).json({ error: 'Campaign name is required' });
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    // Determine target outlets
    let targetIds = [];
    if (outlet_ids === 'all') {
      const { data: outlets } = await supabaseAdmin
        .from('tenants').select('id').eq('brand_id', req.params.id).eq('is_active', true);
      targetIds = (outlets ?? []).map(o => o.id);
    } else {
      targetIds = Array.isArray(outlet_ids) ? outlet_ids : [outlet_ids];
    }

    // Create a broadcast_campaign record per outlet and delegate to existing marketing infra
    const campaigns = await Promise.allSettled(
      targetIds.map(outletId =>
        supabaseAdmin.from('broadcast_campaigns').insert({
          restaurant_id:    outletId,
          name:             `[CHAIN] ${name}`,
          segment_type:     segment,
          template_name:    template_name,
          status:           'queued',
          created_by:       req.user.sub,
          scheduled_at:     new Date().toISOString(),
        }).select().single()
      )
    );

    const created   = campaigns.filter(r => r.status === 'fulfilled').length;
    const failed    = campaigns.filter(r => r.status === 'rejected').length;

    res.json({
      success: true,
      message: `Cross-outlet campaign queued for ${created} outlet(s).${failed ? ` ${failed} outlet(s) failed.` : ''}`,
      queued:  created,
      failed,
    });
  } catch (err) { handleErr(res, err); }
});


// ── Shared helper: createOutlet ───────────────────────────────────────────────
//
// Used by POST / (first outlet) and POST /:id/outlets.
// Returns { restaurant_id, integration_id?, tables_created }

async function createOutlet(brandId, opts) {
  const {
    name,
    address          = null,
    city             = null,
    outlet_code      = null,
    sort_order       = 0,
    whatsapp_number  = null,
    phone_number_id  = null,   // Meta phone_number_id for this outlet
    access_token     = null,   // WABA access token (can be shared or per-outlet)
    table_count      = 0,
    timezone         = 'Asia/Kolkata',
    owner_email      = null,   // optional: create an outlet-level owner employee
    owner_name       = null,
    owner_password   = null,
  } = opts;

  // Create restaurant row
  const { data: restaurant, error: restErr } = await supabaseAdmin
    .from('tenants')
    .insert({
      brand_id:            brandId,
      name:                name.trim(),
      email:               `outlet-${Date.now()}@brand-${brandId}.internal`, // placeholder; can be updated
      address:             address    || null,
      city:                city       || null,
      outlet_code:         outlet_code || null,
      sort_order,
      whatsapp_number:     whatsapp_number || null,
      timezone,
      is_active:           true,
      subscribed_features: DEFAULT_FEATURES,
    })
    .select()
    .single();

  if (restErr) throw restErr;
  const restaurantId = restaurant.id;

  await ensureRestaurantSubscription(supabaseAdmin, restaurantId, {
    paidFeatures:    opts.paid_features,
    enabledServices: opts.enabled_services,
  });

  // Create restaurant_integrations row if phone_number_id provided
  let integrationId = null;
  if (phone_number_id) {
    const { data: integration, error: intErr } = await supabaseAdmin
      .from('tenant_integrations')
      .insert({
        restaurant_id:     restaurantId,
        provider:          'meta',
        channel:           'whatsapp',
        phone_number_id:   phone_number_id,
        access_token:      access_token   || null,
        is_active:         true,
      })
      .select()
      .single();

    if (intErr) {
      console.warn(`[brands/createOutlet] Integration insert failed (non-fatal): ${intErr.message}`);
    } else {
      integrationId = integration.id;
      // Invalidate phone cache so the new number is routed immediately
      invalidatePhoneCache(phone_number_id);
    }
  }

  // Auto-create tables
  let tablesCreated = 0;
  const count = parseInt(table_count) || 0;
  if (count > 0) {
    const tableRows = Array.from({ length: count }, (_, i) => ({
      restaurant_id: restaurantId,
      table_number:  i + 1,
      capacity:      4,
      status:        'available',
      is_active:     true,
    }));
    const { error: tableErr } = await supabaseAdmin.from('tables').insert(tableRows);
    if (tableErr) {
      console.warn(`[brands/createOutlet] Table creation failed (non-fatal): ${tableErr.message}`);
    } else {
      tablesCreated = count;
    }
  }

  // Optional: create outlet-level owner employee
  let outletOwnerId = null;
  if (owner_email && owner_name && owner_password) {
    try {
      const { data: authData } = await supabaseAdmin.auth.admin.createUser({
        email: owner_email.trim().toLowerCase(),
        password: owner_password,
        email_confirm: true,
      });
      if (authData?.user) {
        await supabaseAdmin.from('employees').insert({
          id:            authData.user.id,
          restaurant_id: restaurantId,
          brand_id:      brandId,
          email:         owner_email.trim().toLowerCase(),
          full_name:     owner_name.trim(),
          role:          'owner',
          is_active:     true,
          hired_at:      new Date().toISOString(),
        });
        outletOwnerId = authData.user.id;
      }
    } catch (ownerErr) {
      console.warn(`[brands/createOutlet] Outlet owner creation failed (non-fatal): ${ownerErr.message}`);
    }
  }

  console.log(`[brands] ✅ Outlet created: ${name} (${restaurantId}) under brand ${brandId}`);

  return {
    restaurant_id:  restaurantId,
    integration_id: integrationId,
    tables_created: tablesCreated,
    outlet_owner_id: outletOwnerId,
  };
}

module.exports = router;
