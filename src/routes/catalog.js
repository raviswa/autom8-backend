// src/routes/catalog.js
// ============================================================================
// Catalog, menu, and slot management
//
// POST /api/catalog/sync          — Pull products from Meta catalog → menu_items
// GET  /api/catalog/webhook       — Meta catalog webhook verification
// POST /api/catalog/webhook       — Meta catalog change events
// POST /api/catalog/slot-sync     — Manual slot override (owner/manager)
// GET  /api/catalog/feed          — CSV feed for Meta product catalog
// GET  /api/catalog/feed/template — JSON template for Excel upload preview
// GET  /api/internal/menu-items   — Used by Python chat agent (secret-gated)
// POST /api/menu/upload           — Bulk menu upload from Excel/CSV
// PUT  /api/menu-items/:id/availability — Toggle item in/out of stock + Meta push
//
// NOTE: PUT /api/menu-items/:id/availability is the AUTHORITATIVE version.
//       Remove router.put('/menu-items/:id/availability') from pos.js after
//       deploying this file — the pos.js version lacks the Meta catalog push.
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabase, supabaseAdmin } = require('../config/supabase');
const { getMetaCatalogId, getWhatsAppIntegration } = require('../helpers/restaurantConfig');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');
const { writeAuditLog } = require('../helpers/auditLog');

const { getKdsSecret } = require('../config/internalSecret');

// ── Slot definitions (must match Python agent SLOTS) ─────────────────────────
const SLOTS = [
  { startHour:  6, endHour: 11, dbValue: 'morning_tiffin' },
  { startHour: 11, endHour: 15, dbValue: 'lunch'          },
  { startHour: 15, endHour: 19, dbValue: 'snacks'         },
  { startHour: 19, endHour: 24, dbValue: 'dinner'         },
];

function getCurrentSlotIST() {
  const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const hour   = nowIST.getUTCHours();
  return SLOTS.find(s => hour >= s.startHour && hour < s.endHour)?.dbValue ?? null;
}

const SLOT_DISPLAY_LABELS = {
  morning_tiffin: 'Morning Tiffin',
  lunch:          'Lunch',
  snacks:         'Evening Snacks',
  dinner:         'Dinner',
};

function nextOpenLabelIST() {
  const hour = new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCHours();
  for (const s of SLOTS) {
    if (hour < s.startHour) {
      const h12 = s.startHour % 12 || 12;
      const ampm = s.startHour < 12 ? 'AM' : 'PM';
      return `${h12}:00 ${ampm}`;
    }
  }
  const first = SLOTS[0];
  const h12 = first.startHour % 12 || 12;
  return `${h12}:00 AM`;
}

function mapTimeSlot(raw) {
  if (!raw) return 'all';
  const MAP = {
    'morning tiffin': 'morning_tiffin', morning_tiffin: 'morning_tiffin',
    lunch: 'lunch',
    'evening snacks': 'snacks',         snacks: 'snacks', evening_snacks: 'snacks',
    'dinner tiffin':  'dinner',         dinner: 'dinner', dinner_tiffin: 'dinner',
    all: 'all',
  };
  return MAP[String(raw).toLowerCase().trim()] || 'all';
}

/** DB time_slot values that belong to the active scheduler slot (aliases included). */
function slotDbValuesForActive(slotDbValue) {
  const ALIASES = {
    morning_tiffin: ['morning_tiffin'],
    lunch:          ['lunch'],
    snacks:         ['snacks', 'evening_snacks'],
    dinner:         ['dinner', 'dinner_tiffin'],
  };
  return ALIASES[slotDbValue] ?? [slotDbValue];
}

async function applySlotAvailability(restaurantId, slotDbValue) {
  console.log(`⏰ Applying slot: ${slotDbValue ?? 'CLOSED'} for restaurant ${restaurantId}`);
  if (!slotDbValue) {
    await supabaseAdmin.from('menu_items')
      .update({ is_available: false, updated_at: new Date().toISOString() })
      .eq('restaurant_id', restaurantId);
    return { available: 0, unavailable: 'all' };
  }
  const activeSlots = [...slotDbValuesForActive(slotDbValue), 'all'];
  const { data: activated,   error: e1 } = await supabaseAdmin.from('menu_items')
    .update({ is_available: true,  updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId).eq('is_stocked', true)
    .in('time_slot', activeSlots).select('id');
  if (e1) throw e1;
  const inList = activeSlots.map(s => `"${s}"`).join(',');
  const { data: deactivated, error: e2 } = await supabaseAdmin.from('menu_items')
    .update({ is_available: false, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId)
    .not('time_slot', 'in', `(${inList})`).select('id');
  if (e2) throw e2;
  await supabaseAdmin.from('menu_items')
    .update({ is_available: false, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId).eq('is_stocked', false)
    .in('time_slot', activeSlots);
  console.log(`  ✅ Activated: ${activated?.length ?? 0} | Deactivated: ${deactivated?.length ?? 0}`);
  return { slot: slotDbValue, available: activated?.length ?? 0, unavailable: deactivated?.length ?? 0 };
}

async function syncCatalogFromMeta(restaurantId) {
  const META_CATALOG_ID = await getMetaCatalogId(restaurantId);
  const creds = await getWhatsAppIntegration(restaurantId);
  const META_ACCESS_TOKEN = creds?.accessToken || process.env.META_ACCESS_TOKEN;
  if (!META_ACCESS_TOKEN || !META_CATALOG_ID) {
    return { success: false, error: 'Missing Meta catalog or access token for this restaurant' };
  }

  console.log(`🔄 [catalog-sync] Starting for restaurant ${restaurantId}...`);
  try {
    let allProducts = [], nextUrl =
      `https://graph.facebook.com/v20.0/${META_CATALOG_ID}/products` +
      `?fields=id,name,description,price,currency,image_url,availability,category,retailer_id,custom_label_0` +
      `&limit=100&access_token=${META_ACCESS_TOKEN}`;

    while (nextUrl) {
      const resp = await fetch(nextUrl);
      const data = await resp.json();
      if (data.error) throw new Error(`Meta API: ${data.error.message}`);
      allProducts = [...allProducts, ...(data.data || [])];
      nextUrl = data.paging?.next || null;
    }

    let synced = 0, skipped = 0;
    const errors = [];
    const SLOT_MAP = { 'morning tiffin': 'morning_tiffin', lunch: 'lunch', 'evening snacks': 'snacks', 'dinner tiffin': 'dinner' };

    for (const product of allProducts) {
      try {
        let price = 0;
        if (typeof product.price === 'string') {
          const numeric = parseFloat(product.price.replace(/[^0-9.]/g, ''));
          if (!isNaN(numeric)) {
            price = (product.price.includes('₹') || product.price.toUpperCase().includes('INR'))
              ? numeric : numeric / 100;
          }
        } else if (typeof product.price === 'number') {
          price = product.price > 100 ? product.price / 100 : product.price;
        }

        const timeSlot = SLOT_MAP[(product.custom_label_0 || '').trim().toLowerCase()] || 'all';
        const { error } = await supabaseAdmin.from('menu_items').upsert({
          restaurant_id: restaurantId, name: product.name?.trim(),
          description:   product.description?.trim() || '',
          price, image_url: product.image_url || null,
          category:      product.category || 'General',
          time_slot:     timeSlot,
          meta_product_id: product.id,
          retailer_id:   product.retailer_id || product.id,
          updated_at:    new Date().toISOString(),
        }, { onConflict: 'restaurant_id,meta_product_id', ignoreDuplicates: false });

        if (error) throw error;
        synced++;
      } catch (itemErr) {
        skipped++;
        errors.push({ product_id: product.id, error: itemErr.message });
      }
    }

    await applySlotAvailability(restaurantId, getCurrentSlotIST());
    return { success: true, synced, skipped, total: allProducts.length };
  } catch (err) {
    console.error('❌ Catalog sync failed:', err.message);
    return { success: false, error: err.message };
  }
}

async function triggerMetaFeedRefetch() {
  try {
    const token    = process.env.META_ACCESS_TOKEN;
    const sourceId = process.env.META_DATA_SOURCE_ID || process.env.META_FEED_ID;
    if (!token || !sourceId) return;

    const feedsResp = await fetch(
      `https://graph.facebook.com/v20.0/${sourceId}/feeds?access_token=${token}`
    );
    const feedsData = await feedsResp.json();

    if (!feedsResp.ok || !feedsData.data?.length) {
      const r = await fetch(`https://graph.facebook.com/v20.0/${sourceId}/uploads`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) console.log(`[meta-feed-trigger] ✅ Direct trigger`);
      return;
    }

    const feedId = feedsData.data[0].id;
    const resp   = await fetch(`https://graph.facebook.com/v20.0/${feedId}/uploads`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (resp.ok) console.log(`[meta-feed-trigger] ✅ Feed upload triggered`);
  } catch (err) {
    console.warn('[meta-feed-trigger] Non-fatal:', err.message);
  }
}

async function pushSingleItemToMetaCatalog({ retailerId, isAvailable, restaurantId }) {
  const META_CATALOG_ID = await getMetaCatalogId(restaurantId);
  const creds = await getWhatsAppIntegration(restaurantId);
  const META_ACCESS_TOKEN = creds?.accessToken || process.env.META_ACCESS_TOKEN;
  if (!META_ACCESS_TOKEN || !META_CATALOG_ID) return;

  const { data: item } = await supabaseAdmin
    .from('menu_items').select('name, description, price, image_url, time_slot')
    .eq('retailer_id', retailerId).eq('restaurant_id', restaurantId).maybeSingle();

  const SLOT_LABEL = {
    morning_tiffin: 'Morning Tiffin', lunch: 'Lunch',
    snacks: 'Evening Snacks', dinner: 'Dinner', all: 'All Day',
  };

  const batchPayload = {
    allow_upsert: true,
    requests: [{
      method:      'UPDATE',
      retailer_id: retailerId,
      data: {
        availability: isAvailable ? 'in stock' : 'out of stock',
        ...(item ? {
          name:           item.name        || '',
          description:    item.description || '',
          price:          Math.round((parseFloat(item.price) || 0) * 100),
          currency:       'INR',
          image_url:      item.image_url   || '',
          custom_label_0: SLOT_LABEL[item.time_slot] || 'All Day',
          url:            process.env.FRONTEND_URL || 'https://autom8.works/',
          brand:          'Munafe',
          category:       'FOOD_AND_DRINK',
        } : {}),
      },
    }],
  };

  const resp   = await fetch(`https://graph.facebook.com/v20.0/${META_CATALOG_ID}/batch`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(batchPayload),
    signal:  AbortSignal.timeout(8_000),
  });
  const result = await resp.json();
  if (!resp.ok || result.error) throw new Error(JSON.stringify(result.error || result));
  console.log(`[meta-single-push] ✅ ${retailerId} → ${isAvailable ? 'in stock' : 'out of stock'}`);
}

// ── POST /api/catalog/sync ────────────────────────────────────────────────────

router.post('/sync', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });
    const result = await syncCatalogFromMeta(req.restaurant_id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/catalog/webhook — Meta verification ──────────────────────────────

router.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Meta catalog webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).json({ error: 'Forbidden' });
});

// ── POST /api/catalog/webhook — catalog change events ────────────────────────

router.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  try {
    if (req.body.object !== 'product_catalog') return;
    const { data: restaurants } = await supabaseAdmin.from('restaurants').select('id').eq('is_active', true);
    for (const r of restaurants ?? [])
      syncCatalogFromMeta(r.id).catch(err => console.error(`[catalog-webhook] Sync failed for ${r.id}:`, err.message));
  } catch (err) {
    console.error('[catalog-webhook] Handler error:', err.message);
  }
});

// ── GET /api/catalog/kitchen-status — Manager portal kitchen open/closed ─────

router.get('/kitchen-status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const currentSlot = getCurrentSlotIST();
    const [itemsResult, restResult] = await Promise.all([
      supabaseAdmin.from('menu_items')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', req.restaurant_id)
        .eq('is_available', true)
        .eq('is_stocked', true),
      supabaseAdmin.from('restaurants')
        .select('kitchen_busy, takeaway_ready_range, delivery_ready_range')
        .eq('id', req.restaurant_id)
        .maybeSingle(),
    ]);
    if (itemsResult.error) throw itemsResult.error;
    if (restResult.error) throw restResult.error;
    const rest = restResult.data;
    const count = itemsResult.count;

    res.json({
      success: true,
      is_open: (count ?? 0) > 0,
      available_items: count ?? 0,
      kitchen_busy: !!rest?.kitchen_busy,
      takeaway_ready_range: rest?.takeaway_ready_range ?? null,
      delivery_ready_range: rest?.delivery_ready_range ?? null,
      current_slot: currentSlot,
      current_slot_label: currentSlot ? SLOT_DISPLAY_LABELS[currentSlot] : null,
      schedule_open: currentSlot != null,
      next_open_label: nextOpenLabelIST(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/catalog/kitchen-toggle — Manager open/close for WhatsApp orders ─

router.post('/kitchen-toggle', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const { open } = req.body;
    if (typeof open !== 'boolean')
      return res.status(400).json({ error: 'open (boolean) required' });

    let result;
    if (open) {
      const slot = getCurrentSlotIST();
      if (slot) {
        result = await applySlotAvailability(req.restaurant_id, slot);
      } else {
        const { data, error } = await supabaseAdmin.from('menu_items')
          .update({ is_available: true, updated_at: new Date().toISOString() })
          .eq('restaurant_id', req.restaurant_id)
          .eq('is_stocked', true)
          .select('id');
        if (error) throw error;
        result = { slot: 'manual', available: data?.length ?? 0 };
      }
    } else {
      result = await applySlotAvailability(req.restaurant_id, null);
    }

    res.json({ success: true, is_open: open, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/catalog/kitchen-busy-toggle — Manager rush-hour flag ───────────

router.post('/kitchen-busy-toggle', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const { busy } = req.body;
    if (typeof busy !== 'boolean')
      return res.status(400).json({ error: 'busy (boolean) required' });

    const { data, error } = await supabaseAdmin.from('restaurants').update({
      kitchen_busy: busy,
      updated_at: new Date().toISOString(),
    }).eq('id', req.restaurant_id).select('kitchen_busy').single();

    if (error) throw error;

    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: busy ? 'Kitchen marked busy' : 'Kitchen marked normal',
      details: { kitchen_busy: busy },
    });

    res.json({ success: true, kitchen_busy: data.kitchen_busy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/catalog/slot-sync — Manual slot override ───────────────────────

router.post('/slot-sync', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const slot       = req.body.slot ?? getCurrentSlotIST();
    const validSlots = [...SLOTS.map(s => s.dbValue), null];
    if (req.body.slot !== undefined && !validSlots.includes(req.body.slot))
      return res.status(400).json({ error: `Invalid slot. Must be one of: ${SLOTS.map(s => s.dbValue).join(', ')}` });

    const result = await applySlotAvailability(req.restaurant_id, slot);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/catalog/feed — CSV product feed for Meta ────────────────────────

router.get('/feed', async (req, res) => {
  try {
    const restaurantId = req.query.restaurant_id || process.env.DEFAULT_RESTAURANT_ID;
    const { data: rawItems, error } = await supabaseAdmin
      .from('menu_items')
      .select('retailer_id, name, description, price, image_url, time_slot, is_stocked, is_available, category')
      .eq('restaurant_id', restaurantId).not('retailer_id', 'is', null)
      .order('time_slot', { ascending: true }).order('name', { ascending: true });

    if (error) throw error;
    if (!rawItems?.length) return res.status(404).json({ error: 'No menu items found' });

    const seen  = new Set();
    const items = rawItems.filter(item => {
      if (seen.has(item.retailer_id)) return false;
      seen.add(item.retailer_id); return true;
    });

    const baseUrl    = process.env.FRONTEND_URL || 'https://autom8.works/';
    const escCsv     = v => { const s = String(v || '').replace(/"/g, '""'); return /[,"\n\r]/.test(s) ? `"${s}"` : s; };
    const SLOT_LABEL = { morning_tiffin: 'Morning Tiffin', lunch: 'Lunch', snacks: 'Evening Snacks', dinner: 'Dinner', all: 'All Day' };

    const csvHeader = 'id,title,description,availability,condition,price,link,image_link,brand,google_product_category,custom_label_0';
    const rows = items.map(item => [
      escCsv(item.retailer_id), escCsv(item.name), escCsv(item.description || 'Freshly prepared'),
      // Use is_stocked (not is_available) — slot rotation flips is_available hourly
      // but Meta feed should reflect permanent stock status, not current slot
      item.is_stocked !== false ? 'in stock' : 'out of stock',
      'new', escCsv(`${(item.price || 0).toFixed(2)} INR`),
      escCsv(baseUrl), escCsv(item.image_url || ''),
      'Munafe', '5765', escCsv(SLOT_LABEL[item.time_slot] || 'All Day'),
    ].join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send([csvHeader, ...rows].join('\n'));
    console.log(`[catalog-feed] ✅ Served ${items.length} items`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function exportCategoryLabel(category) {
  const c = String(category || '').trim();
  return c && c !== 'General' ? c : '';
}

// ── GET /api/catalog/feed/template — JSON for Excel download (manager portal) ─

router.get('/feed/template', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const restaurantId = req.restaurant_id || req.query.restaurant_id || process.env.DEFAULT_RESTAURANT_ID;
    if (!restaurantId) return res.status(403).json({ error: 'No restaurant outlet linked to this account' });

    const { data: rawItems, error } = await supabaseAdmin
      .from('menu_items')
      .select('retailer_id, name, description, price, image_url, is_stocked, is_available, category')
      .eq('restaurant_id', restaurantId).not('retailer_id', 'is', null)
      .eq('is_stocked', true)
      .order('category', { ascending: true }).order('name', { ascending: true });

    if (error) throw error;
    if (!rawItems?.length) return res.status(404).json({ error: 'No menu items found' });

    const seen  = new Set();
    const items = rawItems.filter(item => {
      if (seen.has(item.retailer_id)) return false;
      seen.add(item.retailer_id); return true;
    });

    const rows = items.map(item => ({
      id:            item.retailer_id,
      title:         item.name || '',
      description:   item.description || '',
      price:         Number(item.price) || 0,
      category:      exportCategoryLabel(item.category),
      image_link:    item.image_url || '',
      is_available:  (item.is_stocked !== false && item.is_available !== false) ? 'TRUE' : 'FALSE',
    }));

    res.json({ success: true, items: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET internal menu — Python chat service ───────────────────────────────────
//   /api/catalog/internal-menu
//   /api/internal/menu-items  (alias registered in server.js)

async function handleInternalMenuItems(req, res) {
  try {
    if (req.headers['x-internal-secret'] !== getKdsSecret())
      return res.status(403).json({ error: 'Forbidden' });
    const restaurantId = req.query.restaurant_id;
    if (!restaurantId) return res.status(400).json({ error: 'restaurant_id required' });

    const { data, error } = await supabaseAdmin.from('menu_items')
      .select('id, name, description, price, image_url, time_slot, retailer_id, is_available, is_stocked, category, is_special_today')
      .eq('restaurant_id', restaurantId)
      .eq('is_available', true)
      .order('time_slot', { ascending: true }).order('name', { ascending: true });

    if (error) throw error;
    res.json({ success: true, count: data.length, items: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

router.get('/internal-menu', handleInternalMenuItems);

// ── POST /api/menu/upload (and /api/catalog/menu-upload) — Bulk menu upload ──

async function handleMenuUpload(req, res) {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const { items } = req.body;
    if (!items || !Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'items array required' });

    const restaurantId = req.restaurant_id;
    let upserted = 0, skipped = 0, purged = 0;
    const errors = [];

    // Phase 0: remove duplicate retailer_id rows (keep newest)
    try {
      const { data: allRows } = await supabaseAdmin.from('menu_items')
        .select('id, retailer_id, updated_at').eq('restaurant_id', restaurantId)
        .not('retailer_id', 'is', null).order('updated_at', { ascending: false });
      const seen = new Map(), dupIds = [];
      for (const row of allRows ?? []) {
        if (seen.has(row.retailer_id)) dupIds.push(row.id);
        else seen.set(row.retailer_id, row.id);
      }
      if (dupIds.length > 0) {
        await supabaseAdmin.from('menu_items').delete().in('id', dupIds);
        console.log(`[menu/upload] 🧹 Removed ${dupIds.length} duplicate rows`);
      }
    } catch (dedupErr) {
      console.warn('[menu/upload] Dedup failed (non-fatal):', dedupErr.message);
    }

    // Phase 1: parse + validate
    const validRows = [], payloadIds = [];
    for (const item of items) {
      const itemName   = item.name || item.title;
      const retailerId = item.retailer_id || item.id;
      if (!retailerId || !itemName) { errors.push({ row_id: retailerId, error: 'Missing retailer_id or name' }); skipped++; continue; }

      const price = parseFloat(item.price) || 0;
      if (price <= 0) { errors.push({ row_id: retailerId, error: `Invalid price: ${item.price}` }); skipped++; continue; }

      let isStocked = true;
      if (item.is_available !== undefined && item.is_available !== null && item.is_available !== '') {
        const raw = String(item.is_available).toLowerCase().trim();
        isStocked = raw === 'true' || raw === '1' || raw === 'yes';
      }

      payloadIds.push(String(retailerId).trim());
      const now = new Date().toISOString();
      validRows.push({
        restaurant_id: restaurantId,
        retailer_id:   String(retailerId).trim(),
        name:          String(itemName).trim(),
        description:   String(item.description || '').trim(),
        price,
        image_url:     item.image_url || item.image_link || null,
        time_slot:     'all',
        category:      String(item.category || '').trim() || 'General',
        is_stocked:    isStocked,
        is_available:  isStocked,
        created_at:    now,
        updated_at:    now,
      });
    }

    if (!validRows.length) return res.status(400).json({ error: 'No valid rows found', skipped, errors });

    // Phase 2: upsert
    for (const row of validRows) {
      try {
        const { error: dbErr } = await supabaseAdmin.from('menu_items')
          .upsert(row, { onConflict: 'restaurant_id,retailer_id', ignoreDuplicates: false });
        if (dbErr) {
          errors.push({ row_id: row.retailer_id, error: dbErr.message });
          skipped++;
        } else {
          upserted++;
        }
      } catch (itemErr) {
        errors.push({ row_id: row.retailer_id, error: itemErr.message });
        skipped++;
      }
    }

    // Phase 3: purge orphans (items no longer in the uploaded payload)
    if (payloadIds.length > 0) {
      try {
        const { data: existing } = await supabaseAdmin.from('menu_items')
          .select('id, retailer_id, name').eq('restaurant_id', restaurantId).not('retailer_id', 'is', null);
        const payloadSet = new Set(payloadIds);
        const toDelete   = (existing ?? []).filter(r => !payloadSet.has(r.retailer_id));
        if (toDelete.length > 0) {
          await supabaseAdmin.from('menu_items').delete().in('id', toDelete.map(r => r.id));
          purged = toDelete.length;
          console.log(`[menu/upload] 🗑️ Purged ${purged} stale items`);
        }
      } catch (purgeErr) {
        console.warn('[menu/upload] Purge failed (non-fatal):', purgeErr.message);
      }
    }

    // Phase 4: audit
    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: restaurantId,
      action: 'Menu items uploaded via Excel', details: { upserted, skipped, purged },
    });

    // Phase 5: trigger Meta feed refetch
    triggerMetaFeedRefetch().catch(e => console.warn('[menu/upload] Meta trigger failed:', e.message));

    const response = { success: true, upserted, skipped, purged, total: items.length };
    if (errors.length) response.errors = errors;
    res.json(response);
  } catch (err) {
    console.error('[menu/upload]', err.message);
    res.status(500).json({ error: err.message });
  }
}

const menuUploadMiddleware = [authenticateToken, getRestaurantId, handleMenuUpload];
router.post('/menu-upload', ...menuUploadMiddleware);

// ── PUT /api/menu-items/:id/availability — Toggle stock + Meta Catalog push ──

async function handleMenuItemAvailability(req, res) {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const { is_available } = req.body;
    if (typeof is_available !== 'boolean')
      return res.status(400).json({ error: 'is_available (boolean) required' });

    const { data: item, error: fetchErr } = await supabaseAdmin
      .from('menu_items').select('id, retailer_id, name, is_stocked')
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id).single();

    if (fetchErr || !item) return res.status(404).json({ error: 'Menu item not found' });

    const { error: updateErr } = await supabaseAdmin.from('menu_items').update({
      is_stocked:   is_available,
      is_available: is_available,
      updated_at:   new Date().toISOString(),
    }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id);

    if (updateErr) throw updateErr;

    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: `Menu item ${is_available ? 'marked in stock' : 'marked out of stock'}`,
      details: { item_id: req.params.id, item_name: item.name, is_available },
    });

    res.json({ success: true, id: req.params.id, is_available, name: item.name });

    if (item.retailer_id) {
      pushSingleItemToMetaCatalog({
        retailerId:   item.retailer_id,
        isAvailable:  is_available,
        restaurantId: req.restaurant_id,
      }).catch(e => console.error(`[toggle-meta-sync] Failed for ${item.name}:`, e.message));
    }
  } catch (err) {
    console.error('[menu-item-availability]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

const menuItemAvailabilityMiddleware = [authenticateToken, getRestaurantId, handleMenuItemAvailability];
router.put('/menu-items/:id/availability', ...menuItemAvailabilityMiddleware);

// ── PUT /api/menu-items/:id/special-today — Mark special dish (no Meta push) ─

async function handleMenuItemSpecialToday(req, res) {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const { is_special_today } = req.body;
    if (typeof is_special_today !== 'boolean')
      return res.status(400).json({ error: 'is_special_today (boolean) required' });

    const { data: item, error: fetchErr } = await supabaseAdmin
      .from('menu_items').select('id, name')
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id).single();

    if (fetchErr || !item) return res.status(404).json({ error: 'Menu item not found' });

    const { error: updateErr } = await supabaseAdmin.from('menu_items').update({
      is_special_today,
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id);

    if (updateErr) {
      if (/is_special_today/i.test(updateErr.message)) {
        return res.status(500).json({
          error: 'Special dish feature not enabled — run migrations/add_catalog_parcel_and_specials.sql in Supabase.',
        });
      }
      throw updateErr;
    }

    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: is_special_today ? "Marked today's special" : "Removed today's special",
      details: { item_id: req.params.id, item_name: item.name, is_special_today },
    });

    res.json({ success: true, id: req.params.id, is_special_today, name: item.name });
  } catch (err) {
    console.error('[menu-item-special-today]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

const menuItemSpecialTodayMiddleware = [authenticateToken, getRestaurantId, handleMenuItemSpecialToday];
router.put('/menu-items/:id/special-today', ...menuItemSpecialTodayMiddleware);

/** Clear all is_special_today flags (called daily at midnight IST). */
async function resetDailySpecialDishes() {
  const { data, error } = await supabaseAdmin
    .from('menu_items')
    .update({ is_special_today: false, updated_at: new Date().toISOString() })
    .eq('is_special_today', true)
    .select('id');

  if (error) {
    console.error('[special-dish-reset] Error:', error.message);
    return 0;
  }
  const n = data?.length ?? 0;
  if (n) console.log(`[special-dish-reset] Cleared ${n} special-dish flag(s)`);
  return n;
}

// Export helpers for use by schedulers/index.js
module.exports = router;
module.exports.getCurrentSlotIST = getCurrentSlotIST;
module.exports.applySlotAvailability = applySlotAvailability;
module.exports.handleInternalMenuItems = handleInternalMenuItems;
module.exports.handleMenuUpload = handleMenuUpload;
module.exports.menuUploadMiddleware = menuUploadMiddleware;
module.exports.menuItemAvailabilityMiddleware = menuItemAvailabilityMiddleware;
module.exports.menuItemSpecialTodayMiddleware = menuItemSpecialTodayMiddleware;
module.exports.resetDailySpecialDishes = resetDailySpecialDishes;
module.exports.applySlotForAllRestaurants = async function() {
  const slot = getCurrentSlotIST();
  const { data: restaurants } = await supabaseAdmin.from('restaurants').select('id').eq('is_active', true);
  for (const r of restaurants ?? [])
    await applySlotAvailability(r.id, slot).catch(e => console.error(`[slot] Failed for ${r.id}:`, e.message));
};
