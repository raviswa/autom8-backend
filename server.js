// ============================================================================
// AUTOM8 BACKEND - MAIN SERVER (MERGED — POS + CHAT)
// server.js
//
// MIGRATION CHANGES vs original:
//   - Supabase clients moved to src/config/supabase.js (single source of truth)
//   - supabaseChat REMOVED — chat tables now live in the same restaurant DB
//   - Auth middleware moved to src/middleware/auth.js
//   - Routes extracted:
//       /api/auth/*       → src/routes/auth.js
//       /api/*  (POS)     → src/routes/pos.js   (orders, KDS, tables, payments, reports)
//       /api/onboarding/* → src/routes/onboarding.js
//       /api/whatsapp/*   → src/routes/webhook.js (routes orders→Node, text→Python)
//   - Dashboard proxy endpoints updated: supabaseChat → supabaseAdmin
//     (bookings, customers, conversation_states all now in same DB)
//   - All other logic (slot scheduler, catalog, tokens, feedback, WS) unchanged
// ============================================================================

const express   = require('express');
const cors      = require('cors');
const dotenv    = require('dotenv');
const http      = require('http');
const WebSocket = require('ws');

dotenv.config();

// ── Supabase clients (single DB — POS + chat merged) ─────────────────────────
const { supabase, supabaseAdmin } = require('./src/config/supabase');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5173',
    process.env.FRONTEND_URL,
  ].filter(Boolean),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.options('*', cors());
app.use(express.json());

// ── Region middleware (attaches req.region for multi-region support) ──────────
app.use(require('./src/middleware/region'));

// ============================================================================
// ROUTES — extracted modules
// ============================================================================

app.use('/api/auth',       require('./src/routes/auth'));
app.use('/api',            require('./src/routes/pos'));
app.use('/api/onboarding', require('./src/routes/onboarding'));
app.use('/api/whatsapp',   require('./src/routes/webhook'));

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    uptime:    process.uptime(),
    region:    process.env.REGION || 'IN',
  });
});

// ============================================================================
// WHATSAPP HELPERS
// ============================================================================

async function sendWhatsAppMessage(toNumber, message) {
  try {
    const response = await fetch(
      `${process.env.WHATSAPP_API_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to:   String(toNumber),
          type: 'text',
          text: { body: message },
        }),
      }
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[WhatsApp] API error:', err);
    } else {
      console.log(`[WhatsApp] ✅ Sent to ${toNumber}`);
    }
  } catch (err) {
    console.error('[WhatsApp] Failed to send message:', err.message);
  }
}

async function sendWhatsAppCatalogMessage(toNumber, restaurantId) {
  try {
    if (!process.env.META_CATALOG_ID) { console.warn('[catalog-msg] META_CATALOG_ID not set'); return; }

    const { data: availableItems } = await supabaseAdmin
      .from('menu_items')
      .select('retailer_id, name')
      .eq('restaurant_id', restaurantId)
      .eq('is_stocked', true)
      .not('retailer_id', 'is', null)
      .order('name', { ascending: true })
      .limit(10);

    if (!availableItems || availableItems.length === 0) return;

    for (const item of availableItems) {
      const response = await fetch(
        `${process.env.WHATSAPP_API_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          method:  'POST',
          headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to:   String(toNumber),
            type: 'interactive',
            interactive: {
              type:   'catalog_message',
              body:   { text: "🍽️ Browse today's menu and add items to your basket 🛒" },
              footer: { text: 'Tap any item to see details and order' },
              action: { name: 'catalog_message', parameters: { thumbnail_product_retailer_id: item.retailer_id } },
            },
          }),
        }
      );
      if (response.ok) { console.log(`[catalog-msg] ✅ Sent to ${toNumber}`); return; }
      const err     = await response.json().catch(() => ({}));
      const errCode = err?.error?.code;
      if (errCode === 131009 || err?.error?.details?.includes('not found')) continue;
      console.error('[catalog-msg] API error:', err);
      return;
    }
    syncCatalogFromMeta(restaurantId).catch(e => console.error('[catalog-msg] Re-sync failed:', e.message));
  } catch (err) {
    console.error('[catalog-msg] Failed:', err.message);
  }
}

// ============================================================================
// SHARED HELPER — notifyOrderReady
// ============================================================================

async function notifyOrderReady({ orderId, restaurantId, kdsItem }) {
  try {
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('orders')
      .update({ status: 'ready' })
      .eq('id', orderId)
      .neq('status', 'ready')
      .neq('status', 'cancelled')
      .select('order_number, table:table_id!left(table_number), walk_in_tokens(phone)')
      .single();

    if (updateErr || !updated) return;

    const phone = updated.walk_in_tokens?.[0]?.phone ?? kdsItem?.customer_phone ?? null;
    if (phone) {
      await sendWhatsAppMessage(phone,
        `✅ *Your order is ready!*\n\nOrder: *${updated.order_number}*\n` +
        (updated.table?.table_number ? `Table: *${updated.table.table_number}*\n` : '') +
        `\nYour food will be served shortly. Enjoy! 🍽️`
      );
    }
    broadcastToRestaurant(restaurantId, {
      type: 'ORDER_READY', order_id: orderId, order_number: updated.order_number,
      table_number: updated.table?.table_number ?? null, timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[notifyOrderReady] Error:', err.message);
  }
}

// ============================================================================
// SLOT SCHEDULER
// ============================================================================

const SLOTS = [
  { startHour: 6,  endHour: 11, dbValue: 'morning_tiffin' },
  { startHour: 11, endHour: 15, dbValue: 'lunch'          },
  { startHour: 15, endHour: 19, dbValue: 'evening_snacks' },
  { startHour: 19, endHour: 23, dbValue: 'dinner_tiffin'  },
];

function getCurrentSlotIST() {
  const now        = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMinutes = (utcMinutes + 330) % (24 * 60);
  const istHour    = Math.floor(istMinutes / 60);
  const slot       = SLOTS.find(s => istHour >= s.startHour && istHour < s.endHour);
  return slot ? slot.dbValue : null;
}

async function applySlotAvailability(restaurantId, slotDbValue) {
  console.log(`⏰ [${new Date().toISOString()}] Applying slot: ${slotDbValue ?? 'CLOSED'} for restaurant ${restaurantId}`);
  if (!slotDbValue) {
    const { error } = await supabaseAdmin.from('menu_items')
      .update({ is_available: false, updated_at: new Date().toISOString() })
      .eq('restaurant_id', restaurantId);
    if (error) throw error;
    return { available: 0, unavailable: 'all' };
  }
  const { data: activated,   error: e1 } = await supabaseAdmin.from('menu_items')
    .update({ is_available: true,  updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId).eq('is_stocked', true)
    .in('time_slot', [slotDbValue, 'all']).select('id');
  if (e1) throw e1;
  const { data: deactivated, error: e2 } = await supabaseAdmin.from('menu_items')
    .update({ is_available: false, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId)
    .not('time_slot', 'in', `("${slotDbValue}","all")`).select('id');
  if (e2) throw e2;
  const { error: e3 } = await supabaseAdmin.from('menu_items')
    .update({ is_available: false, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId).eq('is_stocked', false)
    .in('time_slot', [slotDbValue, 'all']);
  if (e3) throw e3;
  console.log(`  ✅ Activated: ${activated?.length ?? 0} | Deactivated: ${deactivated?.length ?? 0}`);
  return { slot: slotDbValue, available: activated?.length ?? 0, unavailable: deactivated?.length ?? 0 };
}

async function applySlotForAllRestaurants() {
  const slot = getCurrentSlotIST();
  const { data: restaurants, error } = await supabaseAdmin.from('restaurants').select('id').eq('is_active', true);
  if (error) { console.error('Failed to fetch restaurants:', error); return; }
  for (const r of restaurants ?? []) {
    try { await applySlotAvailability(r.id, slot); }
    catch (err) { console.error(`  ❌ Failed for restaurant ${r.id}:`, err.message); }
  }
}

app.post('/api/catalog/slot-sync', async (req, res) => {
  try {
    const { data: userData } = await supabaseAdmin.from('users').select('role, restaurant_id').eq('id', req.user?.sub).single();
    if (userData?.role !== 'owner' && userData?.role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    const slot        = req.body.slot ?? getCurrentSlotIST();
    const validSlots  = SLOTS.map(s => s.dbValue);
    if (req.body.slot && !validSlots.includes(req.body.slot))
      return res.status(400).json({ error: `Invalid slot. Must be one of: ${validSlots.join(', ')}` });
    const result = await applySlotAvailability(userData.restaurant_id, slot);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 2-MINUTE GRACEFUL TIMEOUT MONITOR
// ============================================================================

function startSpecialNotesTimeoutMonitor() {
  setInterval(async () => {
    try {
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      // Now queries unified DB — bookings table is in public schema
      const { data: staleNoteSessions, error } = await supabaseAdmin
        .from('bookings')
        .select('id, customer_id, token_number, restaurant_id, customers(phone, name)')
        .eq('status', 'waiting_for_notes')
        .lt('notes_requested_at', twoMinutesAgo)
        .limit(50);

      if (error) { console.error('[notes-timeout] Query failed:', error.message); return; }

      for (const session of staleNoteSessions ?? []) {
        try {
          const { error: updateErr } = await supabaseAdmin.from('bookings')
            .update({ status: 'confirmed', special_notes: null, confirmed_at: new Date().toISOString() })
            .eq('id', session.id);
          if (updateErr) { console.error(`[notes-timeout] Failed to auto-progress ${session.id}:`, updateErr.message); continue; }

          const customerPhone = session.customers?.phone;
          const customerName  = session.customers?.name || 'Guest';
          if (customerPhone && process.env.WHATSAPP_ACCESS_TOKEN) {
            await sendWhatsAppMessage(customerPhone,
              `✅ *Booking Confirmed!*\n\nHi ${customerName}, your booking (Token: *${session.token_number}*) has been confirmed.\n\nWe look forward to serving you! 🍽️`
            );
          }
          if (process.env.MANAGER_WHATSAPP_NUMBER && process.env.WHATSAPP_ACCESS_TOKEN) {
            await sendWhatsAppMessage(process.env.MANAGER_WHATSAPP_NUMBER,
              `⏰ *Auto-Confirmed Booking*\n\nToken: *${session.token_number}*\nCustomer: ${customerName}\nStatus: Confirmed (no special notes after 2min wait)`
            );
          }
        } catch (sessionErr) {
          console.error(`[notes-timeout] Error processing ${session.id}:`, sessionErr.message);
        }
      }
    } catch (err) {
      console.error('[notes-timeout] Monitor error:', err.message);
    }
  }, 60 * 1000);
  console.log('⏰ Special notes timeout monitor started');
}

function startSlotScheduler() {
  setInterval(async () => {
    const cutoff = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const { data: staleTokens } = await supabaseAdmin.from('walk_in_tokens')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('status', 'seated').lt('seated_at', cutoff).select('table_id');
    for (const token of staleTokens ?? []) {
      if (token.table_id) {
        await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', token.table_id);
        console.log(`[auto-release] Token freed table ${token.table_id}`);
      }
    }
    const { data: staleOrders } = await supabaseAdmin.from('orders')
      .update({ status: 'completed' })
      .in('status', ['pending', 'confirmed', 'in_progress']).lt('created_at', cutoff)
      .select('table_id, id, order_number');
    for (const order of staleOrders ?? []) {
      if (!order.table_id) continue;
      const { data: remaining } = await supabaseAdmin.from('orders').select('id')
        .eq('table_id', order.table_id).in('status', ['pending', 'confirmed', 'in_progress']);
      if (!remaining || remaining.length === 0) {
        await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', order.table_id);
      }
    }
  }, 5 * 60 * 1000);

  let lastAppliedSlot = Symbol('init');
  applySlotForAllRestaurants();
  setInterval(async () => {
    const currentSlot = getCurrentSlotIST();
    if (currentSlot !== lastAppliedSlot) {
      console.log(`🔄 Slot changed: ${String(lastAppliedSlot)} → ${currentSlot}`);
      lastAppliedSlot = currentSlot;
      await applySlotForAllRestaurants();
    }
  }, 60 * 1000);
  console.log('⏰ Slot scheduler started — runs at 06:00, 11:00, 15:00, 19:00, 23:00 IST');

  startFeedbackScheduler();
  startSpecialNotesTimeoutMonitor();
}

// ============================================================================
// CATALOG SYNC
// ============================================================================

async function syncCatalogFromMeta(restaurantId) {
  const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
  const META_CATALOG_ID   = process.env.META_CATALOG_ID;
  if (!META_ACCESS_TOKEN || !META_CATALOG_ID) return { success: false, error: 'Missing Meta credentials' };
  console.log(`🔄 [catalog-sync] Starting for restaurant ${restaurantId}...`);
  try {
    let allProducts = [];
    let nextUrl = `https://graph.facebook.com/v20.0/${META_CATALOG_ID}/products?fields=id,name,description,price,currency,image_url,availability,category,retailer_id,custom_label_0&limit=100&access_token=${META_ACCESS_TOKEN}`;
    while (nextUrl) {
      const response = await fetch(nextUrl);
      const data     = await response.json();
      if (data.error) throw new Error(`Meta API error: ${data.error.message}`);
      allProducts = [...allProducts, ...(data.data || [])];
      nextUrl = data.paging?.next || null;
    }
    let synced = 0, skipped = 0;
    const errors = [];
    for (const product of allProducts) {
      try {
        let price = 0;
        if (product.price) {
          if (typeof product.price === 'string') {
            const raw = product.price.trim();
            const numeric = parseFloat(raw.replace(/[^0-9.]/g, ''));
            if (!isNaN(numeric)) price = (raw.includes('₹') || raw.toUpperCase().includes('INR')) ? numeric : numeric / 100;
          } else if (typeof product.price === 'number') {
            price = product.price > 100 ? product.price / 100 : product.price;
          }
        }
        const SLOT_MAP = { 'morning tiffin': 'morning_tiffin', 'lunch': 'lunch', 'evening snacks': 'evening_snacks', 'dinner tiffin': 'dinner_tiffin' };
        const timeSlot = SLOT_MAP[(product.custom_label_0 || '').trim().toLowerCase()] || 'all';
        const { error } = await supabaseAdmin.from('menu_items').upsert({
          restaurant_id: restaurantId, name: product.name?.trim(), description: product.description?.trim() || '',
          price, image_url: product.image_url || null, category: product.category || 'General',
          time_slot: timeSlot, meta_product_id: product.id, retailer_id: product.retailer_id || product.id,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'restaurant_id,meta_product_id', ignoreDuplicates: false });
        if (error) throw error;
        synced++;
      } catch (itemError) {
        skipped++;
        errors.push({ product_id: product.id, error: itemError.message });
      }
    }
    await applySlotAvailability(restaurantId, getCurrentSlotIST());
    return { success: true, synced, skipped, total: allProducts.length };
  } catch (err) {
    console.error('❌ Catalog sync failed:', err);
    return { success: false, error: err.message };
  }
}

app.post('/api/catalog/sync', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(403).json({ error: 'Invalid token' });
    const { data: userData } = await supabaseAdmin.from('users').select('role, restaurant_id').eq('id', user.id).single();
    if (userData?.role !== 'owner' && userData?.role !== 'manager') return res.status(403).json({ error: 'Unauthorized' });
    const result = await syncCatalogFromMeta(userData.restaurant_id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/catalog/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).json({ error: 'Forbidden' });
});

app.post('/api/catalog/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  try {
    if (req.body.object !== 'product_catalog') return;
    const { data: restaurants } = await supabaseAdmin.from('restaurants').select('id').eq('is_active', true);
    for (const r of restaurants ?? []) syncCatalogFromMeta(r.id).catch(err => console.error(`Webhook sync failed for ${r.id}:`, err));
  } catch (err) {
    console.error('Webhook handler error:', err);
  }
});

async function triggerMetaFeedRefetch() {
  try {
    const META_ACCESS_TOKEN   = process.env.META_ACCESS_TOKEN;
    const META_DATA_SOURCE_ID = process.env.META_DATA_SOURCE_ID || process.env.META_FEED_ID || '936316552566754';
    if (!META_ACCESS_TOKEN) return;
    const feedsResp = await fetch(`https://graph.facebook.com/v20.0/${META_DATA_SOURCE_ID}/feeds?access_token=${META_ACCESS_TOKEN}`);
    const feedsData = await feedsResp.json();
    if (!feedsResp.ok || !feedsData.data?.length) {
      const directResp = await fetch(`https://graph.facebook.com/v20.0/${META_DATA_SOURCE_ID}/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` } });
      const directResult = await directResp.json();
      if (directResp.ok) console.log(`[meta-feed-trigger] ✅ Direct trigger: ${JSON.stringify(directResult)}`);
      return;
    }
    const feedId = feedsData.data[0].id;
    const resp   = await fetch(`https://graph.facebook.com/v20.0/${feedId}/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` } });
    const result = await resp.json();
    if (resp.ok) console.log(`[meta-feed-trigger] ✅ upload_id=${result.id}`);
  } catch (err) {
    console.warn('[meta-feed-trigger] Non-fatal:', err.message);
  }
}

function mapTimeSlot(raw) {
  if (!raw) return 'all';
  const SLOT_MAP = { 'morning tiffin': 'morning_tiffin', 'morning_tiffin': 'morning_tiffin', 'lunch': 'lunch', 'evening snacks': 'evening_snacks', 'evening_snacks': 'evening_snacks', 'dinner tiffin': 'dinner_tiffin', 'dinner_tiffin': 'dinner_tiffin', 'dinner': 'dinner_tiffin', 'all': 'all' };
  return SLOT_MAP[String(raw).toLowerCase().trim()] || 'all';
}

// ============================================================================
// MENU UPLOAD
// ============================================================================

app.post('/api/menu/upload', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(403).json({ error: 'Invalid token' });
    const { data: userData } = await supabaseAdmin.from('users').select('role, restaurant_id').eq('id', user.id).single();
    if (userData?.role !== 'owner' && userData?.role !== 'manager') return res.status(403).json({ error: 'Unauthorized' });

    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'items array required' });

    const restaurantId = userData.restaurant_id;
    let upserted = 0, skipped = 0, purged = 0;
    const errors = [];

    // Phase 0: dedup existing retailer_id rows
    try {
      const { data: allRows } = await supabaseAdmin.from('menu_items').select('id, retailer_id, updated_at').eq('restaurant_id', restaurantId).not('retailer_id', 'is', null).order('updated_at', { ascending: false });
      if (allRows) {
        const seen = new Map(), dupIds = [];
        for (const row of allRows) { if (seen.has(row.retailer_id)) dupIds.push(row.id); else seen.set(row.retailer_id, row.id); }
        if (dupIds.length > 0) { await supabaseAdmin.from('menu_items').delete().in('id', dupIds); console.log(`[menu/upload] 🧹 Removed ${dupIds.length} duplicate rows`); }
      }
    } catch (dedupErr) { console.warn('[menu/upload] Phase 0 failed (non-fatal):', dedupErr.message); }

    // Phase 1: parse & validate
    const validRows = [], payloadIds = [];
    for (const item of items) {
      const itemName   = item.name || item.title;
      const retailerId = item.retailer_id || item.id;
      if (!retailerId || !itemName) { errors.push({ row_id: retailerId || item.id, error: 'Missing retailer_id or name' }); skipped++; continue; }
      payloadIds.push(String(retailerId).trim());
      const price = parseFloat(item.price) || 0;
      if (price <= 0) { errors.push({ row_id: retailerId, error: `Invalid price: ${item.price}` }); skipped++; continue; }
      let isStocked = true;
      if (item.is_available !== undefined && item.is_available !== null && item.is_available !== '') {
        const raw = String(item.is_available).toLowerCase().trim();
        isStocked = raw === 'true' || raw === '1' || raw === 'yes';
      }
      validRows.push({
        menuItem: { restaurant_id: restaurantId, retailer_id: String(retailerId).trim(), name: String(itemName).trim(), description: String(item.description || '').trim(), price, image_url: (item.image_url || item.image_link) ? String(item.image_url || item.image_link).trim() : null, time_slot: mapTimeSlot(item.time_slot || item.custom_label_0), category: item.category || 'General', is_stocked: isStocked, is_available: isStocked, updated_at: new Date().toISOString() },
        retailerId: String(retailerId).trim(),
      });
    }
    if (validRows.length === 0) return res.status(400).json({ error: 'No valid rows found. Catalog unchanged.', skipped, errors });

    // Phase 2: fetch existing
    const { data: existingRows } = await supabaseAdmin.from('menu_items').select('id, retailer_id').eq('restaurant_id', restaurantId);
    const existingMap = new Map((existingRows ?? []).map(r => [r.retailer_id, r.id]));

    // Phase 3: insert or update
    for (const { menuItem, retailerId } of validRows) {
      try {
        const existingId = existingMap.get(retailerId);
        const { error: dbError } = existingId
          ? await supabaseAdmin.from('menu_items').update(menuItem).eq('id', existingId)
          : await supabaseAdmin.from('menu_items').insert(menuItem);
        if (dbError) { errors.push({ row_id: retailerId, error: dbError.message }); skipped++; continue; }
        upserted++;
      } catch (itemError) { errors.push({ row_id: retailerId, error: itemError.message }); skipped++; }
    }

    // Phase 4: purge stale
    if (payloadIds.length > 0) {
      try {
        const { data: purgedRows } = await supabaseAdmin.from('menu_items').delete().eq('restaurant_id', restaurantId).not('retailer_id', 'in', `(${payloadIds.map(id => `"${id}"`).join(',')})`).select('retailer_id, name');
        purged = purgedRows?.length ?? 0;
        if (purged > 0) console.log(`[menu/upload] 🗑️ Purged ${purged} stale item(s)`);
      } catch (purgeEx) { console.warn('[menu/upload] Purge failed (non-fatal):', purgeEx.message); }
    }

    // Phase 5: re-apply slot
    try { const s = getCurrentSlotIST(); if (s) await applySlotAvailability(restaurantId, s); } catch (_) {}

    // Phase 6: audit log
    try { await supabaseAdmin.from('audit_logs').insert({ user_id: user.id, restaurant_id: restaurantId, action: 'Menu items uploaded via Excel', details: { upserted, skipped, purged } }); } catch (_) {}

    // Phase 7: trigger Meta feed refetch
    triggerMetaFeedRefetch().catch(err => console.warn('[menu/upload] Meta feed trigger failed:', err.message));

    const response = { success: true, upserted, skipped, purged, total: items.length };
    if (errors.length > 0) response.errors = errors;
    res.json(response);
  } catch (err) {
    console.error('[menu/upload]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// CATALOG FEED ENDPOINTS
// ============================================================================

app.get('/api/catalog/feed', async (req, res) => {
  try {
    const restaurantId = req.query.restaurant_id || process.env.DEFAULT_RESTAURANT_ID;
    const { data: rawItems, error } = await supabaseAdmin.from('menu_items')
      .select('retailer_id, name, description, price, image_url, time_slot, is_stocked, is_available, category')
      .eq('restaurant_id', restaurantId).not('retailer_id', 'is', null)
      .order('time_slot', { ascending: true }).order('name', { ascending: true });
    if (error) throw error;
    if (!rawItems?.length) return res.status(404).json({ error: 'No menu items found' });

    const seen = new Set();
    const items = rawItems.filter(item => { if (seen.has(item.retailer_id)) return false; seen.add(item.retailer_id); return true; });
    const baseUrl   = process.env.FRONTEND_URL || 'https://autom8.works/';
    const escCsv    = v => { const s = String(v || '').replace(/"/g, '""'); return /[,"\n\r]/.test(s) ? `"${s}"` : s; };
    const SLOT_LABEL = { morning_tiffin: 'Morning Tiffin', lunch: 'Lunch', evening_snacks: 'Evening Snacks', dinner_tiffin: 'Dinner Tiffin', all: 'All Day' };
    const csvHeader  = 'id,title,description,availability,condition,price,link,image_link,brand,google_product_category,custom_label_0';
    const rows = items.map(item => [
      escCsv(item.retailer_id), escCsv(item.name), escCsv(item.description || 'Freshly prepared'),
      (item.is_available && item.is_stocked) ? 'in stock' : 'out of stock',
      'new', escCsv(`${(item.price || 0).toFixed(2)} INR`), escCsv(baseUrl),
      escCsv(item.image_url || ''), 'Munafe', '5765', escCsv(SLOT_LABEL[item.time_slot] || 'All Day'),
    ].join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send([csvHeader, ...rows].join('\n'));
    console.log(`[catalog-feed] ✅ Served ${items.length} items`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/catalog/feed/template', async (req, res) => {
  try {
    const restaurantId = req.query.restaurant_id || process.env.DEFAULT_RESTAURANT_ID;
    const { data: rawItems, error } = await supabaseAdmin.from('menu_items')
      .select('retailer_id, name, description, price, image_url, time_slot, is_stocked, is_available')
      .eq('restaurant_id', restaurantId).not('retailer_id', 'is', null)
      .order('time_slot', { ascending: true }).order('name', { ascending: true });
    if (error) throw error;
    if (!rawItems?.length) return res.status(404).json({ error: 'No menu items found' });
    const seen = new Set();
    const items = rawItems.filter(item => { if (seen.has(item.retailer_id)) return false; seen.add(item.retailer_id); return true; });
    const SLOT_LABEL = { morning_tiffin: 'Morning Tiffin', lunch: 'Lunch', evening_snacks: 'Evening Snacks', dinner_tiffin: 'Dinner Tiffin', all: 'All Day' };
    const rows = items.map(item => ({ id: item.retailer_id, title: item.name || '', description: item.description || '', price: Number(item.price) || 0, custom_label_0: SLOT_LABEL[item.time_slot] || 'All Day', image_link: item.image_url || '', is_available: (item.is_stocked !== false && item.is_available !== false) ? 'TRUE' : 'FALSE' }));
    res.json({ success: true, items: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// INTERNAL MENU ENDPOINT (used by Python chat service)
// ============================================================================

app.get('/api/internal/menu-items', async (req, res) => {
  try {
    const secret   = req.headers['x-internal-secret'];
    const expected = process.env.AUTOM8_KDS_SECRET || 'munafe_kds_sync_2026';
    if (secret !== expected) return res.status(403).json({ error: 'Forbidden' });
    const restaurantId = req.query.restaurant_id;
    if (!restaurantId) return res.status(400).json({ error: 'restaurant_id required' });
    const { data, error } = await supabaseAdmin.from('menu_items')
      .select('id, name, description, price, image_url, time_slot, retailer_id, is_available, is_stocked, category')
      .eq('restaurant_id', restaurantId).order('time_slot', { ascending: true }).order('name', { ascending: true });
    if (error) throw error;
    res.json({ success: true, count: data.length, items: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// WALK-IN TOKEN SYSTEM
// ============================================================================

async function generateTokenId(restaurantId) {
  const { data: allTokens } = await supabaseAdmin.from('walk_in_tokens').select('id').eq('restaurant_id', restaurantId);
  let maxSeq = 0;
  for (const row of allTokens ?? []) { const match = String(row.id).match(/^T-(\d+)$/); if (match) { const n = parseInt(match[1], 10); if (n > maxSeq) maxSeq = n; } }
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `T-${String(maxSeq + 1 + attempt).padStart(3, '0')}`;
    const { data: existing } = await supabaseAdmin.from('walk_in_tokens').select('id').eq('id', candidate).maybeSingle();
    if (!existing) return candidate;
  }
  return `T-${Date.now().toString().slice(-6)}`;
}

app.post('/api/tokens', async (req, res) => {
  try {
    const { name, phone, type, pax, restaurant_id, meta } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!type)         return res.status(400).json({ error: 'type is required' });
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id is required' });
    if (!['dinein', 'takeaway', 'large_party'].includes(type))
      return res.status(400).json({ error: 'type must be dinein, takeaway, or large_party' });

    const tokenId = await generateTokenId(restaurant_id);
    const status  = type === 'large_party' ? 'pending_approval' : type === 'takeaway' ? 'takeaway' : 'waiting';
    const tokenRecord = { id: tokenId, restaurant_id, name: name.trim(), phone: phone ? String(phone).replace(/\D/g, '') : null, type, pax: type === 'takeaway' ? 1 : (parseInt(pax) || 1), status, arrived_at: new Date().toISOString(), meta: meta || {} };
    const { data: token, error: insertError } = await supabaseAdmin.from('walk_in_tokens').insert(tokenRecord).select().single();
    if (insertError) throw insertError;

    const arrivalTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
    if (process.env.MANAGER_WHATSAPP_NUMBER && process.env.WHATSAPP_ACCESS_TOKEN) {
      if (type === 'large_party') {
        const combo = meta?.combo ?? [];
        const tableLines = combo.length > 0 ? combo.map(t => `Table ${t[0]} (${t[2]}/${t[1]} seats)`).join(' + ') : `${token.pax} seats`;
        sendWhatsAppMessage(process.env.MANAGER_WHATSAPP_NUMBER, `🟣 *Large Party Request* — Token *${token.id}*\n👥 ${token.name} · *${token.pax} people*\n🕐 ${arrivalTime}\n\nProposed: ${tableLines}\n\n⚠️ *Action required:*\n${process.env.FRONTEND_URL || ''}/dashboard/manager`);
      } else if (req.query.notify !== 'false') {
        const typeLabel = type === 'dinein' ? 'Dine-in' : 'Takeaway';
        const paxLine   = type === 'dinein' ? `, ${token.pax} ${token.pax === 1 ? 'person' : 'people'}` : '';
        sendWhatsAppMessage(process.env.MANAGER_WHATSAPP_NUMBER, `🪑 *New Walk-in* — Token *${token.id}*\n👤 ${token.name}${paxLine}\n📋 ${typeLabel}\n🕐 ${arrivalTime}\n\n${process.env.FRONTEND_URL || ''}/dashboard/manager`);
      }
    }
    broadcastToRestaurant(restaurant_id, { type: 'NEW_TOKEN', token, timestamp: new Date().toISOString() });
    res.status(201).json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to create token' });
  }
});

app.get('/api/tokens', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(403).json({ error: 'Invalid token' });
    const { data: userData } = await supabaseAdmin.from('users').select('restaurant_id').eq('id', user.id).single();
    const restaurantId = userData?.restaurant_id;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const { status } = req.query;
    let query = supabaseAdmin.from('walk_in_tokens').select('*').eq('restaurant_id', restaurantId).order('arrived_at', { ascending: true });
    if (status) query = query.eq('status', status).gte('arrived_at', todayStart.toISOString());
    else query = query.or(`status.in.(waiting,seated,takeaway,pending_approval),and(status.eq.completed,arrived_at.gte.${todayStart.toISOString()})`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, tokens: data || [] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/tokens/:id', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('walk_in_tokens')
      .select('id, name, phone, status, type, pax, table_number, table_id, arrived_at, seated_at')
      .eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ error: 'Token not found' });
    res.json({ success: true, token: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tokens/:id/assign', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const authToken = authHeader?.split(' ')[1];
    if (!authToken) return res.status(401).json({ error: 'No token' });
    const { data: { user } } = await supabase.auth.getUser(authToken);
    const { data: userData } = await supabaseAdmin.from('users').select('restaurant_id').eq('id', user.id).single();
    const restaurantId = userData?.restaurant_id;

    const { table_id, table_number } = req.body;
    if (!table_id || !table_number) return res.status(400).json({ error: 'table_id and table_number required' });
    const { data: token, error: fetchError } = await supabaseAdmin.from('walk_in_tokens').select('*').eq('id', req.params.id).eq('restaurant_id', restaurantId).single();
    if (fetchError || !token) return res.status(404).json({ error: 'Token not found' });
    if (token.status !== 'waiting') return res.status(400).json({ error: `Token is already ${token.status}` });
    const { data: updatedToken, error: updateError } = await supabaseAdmin.from('walk_in_tokens')
      .update({ status: 'seated', table_id, table_number, seated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('restaurant_id', restaurantId).select().single();
    if (updateError) throw updateError;
    await supabaseAdmin.from('tables').update({ status: 'occupied' }).eq('id', table_id).eq('restaurant_id', restaurantId);
    if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
      await sendWhatsAppMessage(token.phone, `✅ *Your table is ready!*\n\nToken: *${token.id}*\nTable: *Table ${table_number}*\n\nPlease proceed to your table. Enjoy! 🍽️`);
      await sendWhatsAppCatalogMessage(token.phone, restaurantId);
    }
    broadcastToRestaurant(restaurantId, { type: 'TOKEN_ASSIGNED', token: updatedToken, timestamp: new Date().toISOString() });
    await supabaseAdmin.from('audit_logs').insert({ user_id: user.id, restaurant_id: restaurantId, action: 'Token assigned to table', details: { token_id: req.params.id, table_id, table_number } });
    res.json({ success: true, token: updatedToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tokens/:id/approve', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const authToken = authHeader?.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(authToken);
    const { data: userData } = await supabaseAdmin.from('users').select('role, restaurant_id').eq('id', user.id).single();
    if (userData?.role !== 'owner' && userData?.role !== 'manager') return res.status(403).json({ error: 'Unauthorized' });
    const restaurantId = userData.restaurant_id;

    const { data: token } = await supabaseAdmin.from('walk_in_tokens').select('*').eq('id', req.params.id).eq('restaurant_id', restaurantId).single();
    if (!token) return res.status(404).json({ error: 'Token not found' });
    if (token.status !== 'pending_approval') return res.status(400).json({ error: `Token is ${token.status}` });

    const combo        = token.meta?.combo ?? [];
    const tableNumbers = combo.map(t => String(t[0]));
    let tableIds = [];
    if (tableNumbers.length > 0) {
      const { data: tableRows } = await supabaseAdmin.from('tables').select('id, table_number').eq('restaurant_id', restaurantId).in('table_number', tableNumbers);
      tableIds = (tableRows ?? []).map(t => t.id);
    }
    const { data: updatedToken } = await supabaseAdmin.from('walk_in_tokens')
      .update({ status: 'seated', table_id: tableIds[0] ?? null, table_number: tableNumbers[0] ?? null, seated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (tableIds.length > 0) await supabaseAdmin.from('tables').update({ status: 'occupied' }).in('id', tableIds).eq('restaurant_id', restaurantId);
    if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
      await sendWhatsAppMessage(token.phone, `✅ *Your table arrangement has been confirmed.*\n\nToken: *${token.id}*\nParty of: *${token.pax} people*\nTables: *${tableNumbers.join(', ')}*\n\nPlease head to the restaurant! 🍽️`);
      await sendWhatsAppCatalogMessage(token.phone, restaurantId);
    }
    broadcastToRestaurant(restaurantId, { type: 'TOKEN_APPROVED', token: updatedToken, timestamp: new Date().toISOString() });
    res.json({ success: true, token: updatedToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tokens/:id/reject', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const authToken = authHeader?.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(authToken);
    const { data: userData } = await supabaseAdmin.from('users').select('role, restaurant_id').eq('id', user.id).single();
    if (userData?.role !== 'owner' && userData?.role !== 'manager') return res.status(403).json({ error: 'Unauthorized' });

    const { data: token } = await supabaseAdmin.from('walk_in_tokens').select('*').eq('id', req.params.id).eq('restaurant_id', userData.restaurant_id).single();
    if (!token) return res.status(404).json({ error: 'Token not found' });
    const { data: updatedToken } = await supabaseAdmin.from('walk_in_tokens').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
    if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
      const reasonLine = req.body.reason ? `\n\nReason: ${req.body.reason}` : '';
      await sendWhatsAppMessage(token.phone, `😔 *We're unable to accommodate your party of ${token.pax} right now.*${reasonLine}\n\nReply *RESERVE* to book for a future date. 🙏`);
    }
    broadcastToRestaurant(userData.restaurant_id, { type: 'TOKEN_REJECTED', token: updatedToken, timestamp: new Date().toISOString() });
    res.json({ success: true, token: updatedToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tokens/:id/complete', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const authToken = authHeader?.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(authToken);
    const { data: userData } = await supabaseAdmin.from('users').select('restaurant_id').eq('id', user.id).single();
    const restaurantId = userData.restaurant_id;

    const { data: token } = await supabaseAdmin.from('walk_in_tokens').select('*').eq('id', req.params.id).eq('restaurant_id', restaurantId).single();
    if (!token) return res.status(404).json({ error: 'Token not found' });
    const { data: updatedToken } = await supabaseAdmin.from('walk_in_tokens').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
    if (token.table_id) {
      const { data: activeOrders } = await supabaseAdmin.from('orders').select('id').eq('table_id', token.table_id).in('status', ['pending', 'confirmed', 'in_progress']);
      if (!activeOrders || activeOrders.length === 0) {
        await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', token.table_id).eq('restaurant_id', restaurantId);
        if (token.phone) {
          try {
            const { data: tableInfo } = await supabaseAdmin.from('tables').select('table_number').eq('id', token.table_id).single();
            await supabaseAdmin.from('feedback_pending').insert({ restaurant_id: restaurantId, customer_phone: String(token.phone).replace(/\D/g, ''), customer_name: token.name || 'Guest', token_number: token.id, table_number: tableInfo?.table_number, freed_at: new Date().toISOString() });
          } catch (feedbackQueueErr) { console.error('[token-complete] Failed to queue feedback:', feedbackQueueErr.message); }
        }
      }
    }
    broadcastToRestaurant(restaurantId, { type: 'TOKEN_COMPLETED', token: updatedToken, timestamp: new Date().toISOString() });
    res.json({ success: true, token: updatedToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tokens/:id', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const authToken = authHeader?.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(authToken);
    const { data: userData } = await supabaseAdmin.from('users').select('restaurant_id').eq('id', user.id).single();
    const { error } = await supabaseAdmin.from('walk_in_tokens').delete().eq('id', req.params.id).eq('restaurant_id', userData.restaurant_id);
    if (error) throw error;
    res.json({ success: true, message: 'Token dismissed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// FEEDBACK SYSTEM
// ============================================================================

app.post('/api/feedback/queue', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const authToken = authHeader?.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(authToken);
    const { data: userData } = await supabaseAdmin.from('users').select('restaurant_id').eq('id', user.id).single();
    const { customer_phone, customer_name, token_number, table_number } = req.body;
    if (!customer_phone) return res.status(400).json({ error: 'customer_phone required' });
    await supabaseAdmin.from('feedback_pending').insert({ restaurant_id: userData.restaurant_id, customer_phone: String(customer_phone).replace(/\D/g, ''), customer_name: customer_name || 'Guest', token_number: token_number || null, table_number: table_number || null, freed_at: new Date().toISOString() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function handleFeedbackReply(customerPhone, message, restaurantId) {
  try {
    const phone = String(customerPhone).replace(/\D/g, '');
    const { data: record } = await supabaseAdmin.from('feedback_pending').select('*').eq('customer_phone', phone).eq('restaurant_id', restaurantId).eq('manager_notified', false).not('feedback_sent', 'eq', false).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!record) return false;
    const text      = message.trim();
    const starMatch = text.match(/[1-5⭐★]/);
    const rating    = starMatch ? (parseInt(starMatch[0]) || (starMatch[0].match(/[⭐★]/g) || []).length || null) : null;
    await supabaseAdmin.from('feedback_pending').update({ feedback_text: text, feedback_rating: rating, feedback_received_at: new Date().toISOString(), manager_notified: true }).eq('id', record.id);
    await sendWhatsAppMessage(customerPhone, rating && rating >= 4 ? `🙏 Thank you for the *${rating}⭐* rating, ${record.customer_name}!\n\nWe're so glad you enjoyed your visit. See you again soon! 😊` : `🙏 Thank you for your feedback, ${record.customer_name}!\n\nWe'll use it to improve. Hope to see you again! 😊`);
    const ratingLine = rating ? `Rating: ${'⭐'.repeat(rating)} (${rating}/5)\n` : '';
    await sendWhatsAppMessage(process.env.MANAGER_WHATSAPP_NUMBER, `📣 *Customer Feedback*\n────────────────────\nCustomer: ${record.customer_name}\nPhone: +${phone}\nToken: ${record.token_number || '—'}\nTable: ${record.table_number || '—'}\n${ratingLine}Feedback: ${text}\n────────────────────`);
    return true;
  } catch (err) {
    console.error('[feedback-reply]', err.message); return false;
  }
}

function startFeedbackScheduler() {
  setInterval(async () => {
    try {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { data: pending } = await supabaseAdmin.from('feedback_pending').select('*').eq('feedback_sent', false).lte('freed_at', twoHoursAgo).limit(20);
      for (const record of pending ?? []) {
        try {
          await sendWhatsAppMessage(record.customer_phone, `Hi ${record.customer_name}! 😊\n\nThank you for dining with us today${record.table_number ? ` (Table ${record.table_number})` : ''}.\n\n*How was your experience?*\n\n⭐ Reply with a rating from *1 to 5*:\n5 ⭐ — Excellent\n4 ⭐ — Good\n3 ⭐ — Average\n2 ⭐ — Below average\n1 ⭐ — Poor\n\nYou can also add comments. 🙏`);
          await supabaseAdmin.from('feedback_pending').update({ feedback_sent: true, feedback_sent_at: new Date().toISOString() }).eq('id', record.id);
        } catch (innerErr) { console.error(`[feedback-sender] Failed for ${record.customer_phone}:`, innerErr.message); }
      }
    } catch (err) { console.error('[feedback-sender] Scan error:', err.message); }
  }, 10 * 60 * 1000);
  console.log('📣 Feedback scheduler started');
}

// ============================================================================
// SUBSCRIPTION / FEATURE FLAGS
// ============================================================================

app.get('/api/subscription', async (req, res) => {
  res.json({
    success: true, plan: 'pro',
    features: ['dine_in', 'takeaway', 'delivery', 'reserve_table', 'token_management', 'kds', 'analytics', 'marketing', 'whatsapp_ordering', 'catalog_sync', 'reporting'],
    valid_until: null,
  });
});

// ============================================================================
// OWNER DASHBOARD ENDPOINTS
// MIGRATION: supabaseChat → supabaseAdmin (bookings + customers now in same DB)
// ============================================================================

app.get('/api/dashboard/waba', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const authToken = authHeader?.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(authToken);
    const { data: userData } = await supabaseAdmin.from('users').select('restaurant_id').eq('id', user.id).single();

    // Now reads from unified restaurants table (merged DB)
    const { data } = await supabaseAdmin
      .from('restaurants')
      .select('id, name, whatsapp_number, manager_phone, timezone, dining_duration_minutes, payment_mode, waba_id')
      .eq('id', userData.restaurant_id)
      .maybeSingle();

    res.json({ success: true, restaurant: data ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/wa-orders', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const authToken = authHeader?.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(authToken);
    const { data: userData } = await supabaseAdmin.from('users').select('restaurant_id').eq('id', user.id).single();

    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    // Now queries bookings directly from unified DB
    const { data, error } = await supabaseAdmin
      .from('bookings')
      .select('id, created_at, service_type, status, party_size, token_number, payment_status, booking_datetime, token_advance, customer_id, customers(name, phone)')
      .eq('restaurant_id', userData.restaurant_id)
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      console.error('[wa-orders] query failed:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true, orders: data ?? [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/cancel-stats', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const authToken = authHeader?.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(authToken);
    const { data: userData } = await supabaseAdmin.from('users').select('restaurant_id').eq('id', user.id).single();
    const restaurantId = userData.restaurant_id;

    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const [cancelRes, totalRes, bcRes, btRes] = await Promise.all([
      supabaseAdmin.from('orders').select('total_amount').eq('restaurant_id', restaurantId).eq('status', 'cancelled').gte('created_at', start).lte('created_at', end),
      supabaseAdmin.from('orders').select('*', { count: 'exact', head: true }).eq('restaurant_id', restaurantId).gte('created_at', start).lte('created_at', end),
      // bookings now in same DB — no supabaseChat needed
      supabaseAdmin.from('bookings').select('id', { count: 'exact', head: true }).eq('restaurant_id', restaurantId).eq('status', 'cancelled').gte('created_at', start).lte('created_at', end),
      supabaseAdmin.from('bookings').select('id', { count: 'exact', head: true }).eq('restaurant_id', restaurantId).gte('created_at', start).lte('created_at', end),
    ]);

    const orderCancels  = cancelRes.data ?? [];
    const totalOrders   = totalRes.count ?? 0;
    const orderRevLost  = orderCancels.reduce((s, o) => s + (o.total_amount ?? 0), 0);
    const bookingCancels = bcRes.count ?? 0;
    const totalBookings  = btRes.count ?? 0;

    res.json({
      success: true,
      orderCancels: orderCancels.length, orderRevLost, totalOrders,
      orderRate: totalOrders > 0 ? Math.round((orderCancels.length / totalOrders) * 100) : 0,
      bookingCancels, totalBookings,
      bookingRate: totalBookings > 0 ? Math.round((bookingCancels / totalBookings) * 100) : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PUBLIC RESTAURANT RESOLVER
// ============================================================================

app.get('/api/restaurant/default', async (req, res) => {
  try {
    const { data: restaurants, error } = await supabaseAdmin.from('restaurants').select('id').eq('is_active', true).limit(2);
    if (error) throw error;
    if (!restaurants?.length) return res.status(404).json({ error: 'No active restaurant found' });
    if (restaurants.length > 1) return res.status(400).json({ error: 'Multiple restaurants found. QR code URL must include ?restaurant=<id>' });
    res.json({ restaurant_id: restaurants[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// WEBSOCKET
// ============================================================================

const clients = new Map();

wss.on('connection', (ws) => {
  let restaurantId = null;
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'SUBSCRIBE') {
        restaurantId = data.restaurantId;
        if (!clients.has(restaurantId)) clients.set(restaurantId, []);
        clients.get(restaurantId).push(ws);
        ws.send(JSON.stringify({ type: 'SUBSCRIBED', restaurantId, timestamp: new Date().toISOString() }));
      }
    } catch (err) { console.error('WebSocket message error:', err); }
  });
  ws.on('close', () => {
    if (restaurantId && clients.has(restaurantId)) {
      const list = clients.get(restaurantId);
      const index = list.indexOf(ws);
      if (index > -1) list.splice(index, 1);
    }
  });
  ws.on('error', (err) => console.error('WebSocket error:', err.message));
});

function broadcastToRestaurant(restaurantId, data) {
  if (clients.has(restaurantId)) {
    clients.get(restaurantId).forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
    });
  }
}

// ============================================================================
// START SERVER
// ============================================================================

async function runStartupSync() {
  console.log('🚀 Running startup catalog sync...');
  try {
    const { data: restaurants } = await supabaseAdmin.from('restaurants').select('id').eq('is_active', true);
    for (const r of restaurants ?? []) await syncCatalogFromMeta(r.id);
  } catch (err) { console.error('Startup sync error:', err); }
}

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`\n🚀 Autom8 Backend running on port ${PORT}`);
  console.log(`📍 Region: ${process.env.REGION || 'IN'}`);
  console.log(`🗄️  Database: ${process.env.SUPABASE_URL}\n`);
  startSlotScheduler();
  runStartupSync();
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received — closing server');
  server.close(() => console.log('HTTP server closed'));
});

module.exports = { app, wss, broadcastToRestaurant };
