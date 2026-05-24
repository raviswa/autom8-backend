// ============================================================================
// AUTOM8 BACKEND - MAIN SERVER
// server.js
//
// FIX LOG
// -------
//  Fix 1  — GET /api/kds/feed: nested joins changed to LEFT JOINs (!left)
//  Fix 2  — GET /api/kds/feed: 'cancelled' excluded from 'all' status query
//  Fix 3  — POST /api/kds/notify: item_name stored on kds_items at insert
//  Fix 4  — POST /api/kds/notify: token_number and service_type stored
//  Fix 5  — PUT /api/kds/:id/status: order-ready WhatsApp notification
//  Fix 6  — GET /api/tokens: restaurant_id resolved from users table with
//            fallback to auth metadata so queue always loads for manager
//  Fix 7  — GET /api/tokens: debug logging added so empty results are visible
//            in Railway logs with the reason
//  Fix 8  — getRestaurantId: explicit 401 with reason when user not found
//            instead of silent failure that left req.restaurant_id undefined
//  Fix 9  — POST /api/orders/:id/complete: atomic "mark all ready" endpoint
//            that bulk-updates all kds_items and fires exactly ONE WhatsApp
//            notification, eliminating the duplicate-notify race condition
//            from parallel PUT /api/kds/:id/status calls
// ============================================================================

const express   = require('express');
const cors      = require('cors');
const dotenv    = require('dotenv');
const http      = require('http');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Munafe Chat Supabase (separate project — conversation/WABA data)
// Support both naming conventions
const _chatUrl = process.env.CHAT_SUPABASE_URL || process.env.MUNAFE_CHAT_SUPABASE_URL;
const _chatKey = process.env.CHAT_SUPABASE_SERVICE_KEY || process.env.CHAT_SERVICE_ROLE_KEY || process.env.MUNAFE_CHAT_SERVICE_ROLE_KEY;
const supabaseChat = _chatUrl && _chatKey
  ? createClient(_chatUrl, _chatKey)
  : null;
console.log(`[supabaseChat] ${_chatUrl ? '✅ configured: ' + _chatUrl : '❌ not configured — set CHAT_SUPABASE_URL and CHAT_SUPABASE_SERVICE_KEY'}`);

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

// ============================================================================
// AUTH MIDDLEWARE
// ============================================================================

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = { sub: user.id, email: user.email };
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Authentication failed' });
  }
};

// Fix 6 + Fix 8: robust restaurant_id resolution with clear error messages
const getRestaurantId = async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('restaurant_id, role')
      .eq('id', req.user.sub)
      .single();

    if (error) {
      console.error(`[getRestaurantId] DB error for user ${req.user.sub}:`, error.message);
      return res.status(401).json({ error: `User lookup failed: ${error.message}` });
    }

    if (!data) {
      console.error(`[getRestaurantId] No user row found for id=${req.user.sub} email=${req.user.email}`);
      return res.status(401).json({ error: 'User profile not found. Ensure user exists in users table.' });
    }

    if (!data.restaurant_id) {
      console.warn(`[getRestaurantId] User ${req.user.sub} has no restaurant_id in users table`);
      const { data: restaurants } = await supabaseAdmin
        .from('restaurants')
        .select('id')
        .limit(2);
      if (restaurants && restaurants.length === 1) {
        console.warn(`[getRestaurantId] Falling back to single restaurant: ${restaurants[0].id}`);
        req.restaurant_id = restaurants[0].id;
        req.user_role     = data.role;
        return next();
      }
      return res.status(401).json({ error: 'User has no restaurant_id assigned. Update user record in Supabase.' });
    }

    req.restaurant_id = data.restaurant_id;
    req.user_role     = data.role;
    next();
  } catch (err) {
    console.error('[getRestaurantId] Unexpected error:', err.message);
    res.status(401).json({ error: `Auth middleware failed: ${err.message}` });
  }
};

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

app.post('/api/auth/signup', async (req, res) => {
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
    await supabaseAdmin.from('audit_logs').insert({
      user_id: authData.user.id, restaurant_id, action: 'User signup', details: { email, role },
    });
    res.json({ success: true, user: userData });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const { data: userDetails } = await supabaseAdmin
      .from('users').select('*').eq('id', data.user.id).single();
    if (!userDetails) return res.status(401).json({ error: 'User account not fully set up. No profile found.' });
    await supabaseAdmin.from('users').update({ last_login: new Date() }).eq('id', data.user.id);
    await supabaseAdmin.from('audit_logs').insert({
      user_id: data.user.id, restaurant_id: userDetails.restaurant_id,
      action: 'User login', ip_address: req.ip,
    });
    res.json({
      success: true, user: userDetails,
      token: data.session.access_token, refreshToken: data.session.refresh_token,
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/auth/refresh', async (req, res) => {
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
    if (!process.env.META_CATALOG_ID) {
      console.warn('[catalog-msg] META_CATALOG_ID not set');
      return;
    }

    // Fetch all available items ordered by name so the thumbnail is deterministic.
    // We try each one in order until Meta accepts it — this handles the case where
    // some retailer_ids in our DB don't match Meta's catalog (e.g. after a partial
    // sync or if Meta silently dropped a product).
    // Thumbnail query does NOT filter by is_available — the slot scheduler sets
    // all items to false during closed hours, which would silently break the
    // catalog send. The thumbnail is only a visual anchor; availability shown
    // to customers comes from Meta's own catalog, not this query.
    const { data: availableItems, error: itemsError } = await supabaseAdmin
      .from('menu_items')
      .select('retailer_id, name')
      .eq('restaurant_id', restaurantId)
      .eq('is_stocked', true)          // only items actually in stock
      .not('retailer_id', 'is', null)
      .order('name', { ascending: true })
      .limit(10);

    if (itemsError || !availableItems || availableItems.length === 0) {
      console.warn('[catalog-msg] No stocked items found for thumbnail (menu empty or all OOS)');
      return;
    }

    // Try each retailer_id until one works
    for (const item of availableItems) {
      console.log(`[catalog-msg] Trying thumbnail retailer_id=${item.retailer_id} (${item.name})`);
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
            type: 'interactive',
            interactive: {
              type: 'catalog_message',
              body:   { text: "🍽️ Browse today's menu and add items to your basket 🛒" },
              footer: { text: 'Tap any item to see details and order' },
              action: {
                name: 'catalog_message',
                parameters: { thumbnail_product_retailer_id: item.retailer_id },
              },
            },
          }),
        }
      );

      if (response.ok) {
        console.log(`[catalog-msg] ✅ Sent to ${toNumber} using retailer_id=${item.retailer_id}`);
        return; // success — stop trying
      }

      const err = await response.json().catch(() => ({}));
      const errCode = err?.error?.code;
      const errDetail = err?.error?.details ?? err?.error?.message ?? '';

      // 131009 = "Products not found in FB Catalog" — this retailer_id isn't in Meta
      // Try the next item. Any other error is unexpected — log and bail.
      if (errCode === 131009 || errDetail.includes('not found')) {
        console.warn(`[catalog-msg] retailer_id=${item.retailer_id} not in Meta catalog — trying next`);
        continue;
      }

      // Unexpected error — log and stop
      console.error('[catalog-msg] API error (unexpected):', err);
      return;
    }

    // All retailer_ids failed — the catalog message can't be sent right now.
    // This usually means Meta's catalog is out of sync with our menu_items table.
    // Trigger a background re-sync so next time it works.
    console.warn('[catalog-msg] ⚠️  All retailer_ids rejected by Meta. Triggering background catalog re-sync...');
    syncCatalogFromMeta(restaurantId).catch(e =>
      console.error('[catalog-msg] Background re-sync failed:', e.message)
    );

  } catch (err) {
    console.error('[catalog-msg] Failed:', err.message);
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
    const { error } = await supabaseAdmin
      .from('menu_items')
      .update({ is_available: false, updated_at: new Date().toISOString() })
      .eq('restaurant_id', restaurantId);
    if (error) throw error;
    console.log(`  ✅ All items set unavailable (closed hours)`);
    return { available: 0, unavailable: 'all' };
  }
  // Only activate items that are in stock (is_stocked=true).
  // Out-of-stock items stay is_available=false regardless of slot.
  const { data: activated, error: e1 } = await supabaseAdmin
    .from('menu_items')
    .update({ is_available: true, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId)
    .eq('is_stocked', true)
    .in('time_slot', [slotDbValue, 'all'])
    .select('id');
  if (e1) throw e1;
  const { data: deactivated, error: e2 } = await supabaseAdmin
    .from('menu_items')
    .update({ is_available: false, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId)
    .not('time_slot', 'in', `("${slotDbValue}","all")`)
    .select('id');
  if (e2) throw e2;
  // Also deactivate any in-slot items that are out of stock
  const { error: e3 } = await supabaseAdmin
    .from('menu_items')
    .update({ is_available: false, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId)
    .eq('is_stocked', false)
    .in('time_slot', [slotDbValue, 'all']);
  if (e3) throw e3;
  console.log(`  ✅ Activated: ${activated?.length ?? 0} | Deactivated: ${deactivated?.length ?? 0}`);
  return { slot: slotDbValue, available: activated?.length ?? 0, unavailable: deactivated?.length ?? 0 };
}

async function applySlotForAllRestaurants() {
  const slot = getCurrentSlotIST();
  const { data: restaurants, error } = await supabaseAdmin
    .from('restaurants').select('id').eq('is_active', true);
  if (error) { console.error('Failed to fetch restaurants:', error); return; }
  for (const r of restaurants ?? []) {
    try { await applySlotAvailability(r.id, slot); }
    catch (err) { console.error(`  ❌ Failed for restaurant ${r.id}:`, err.message); }
  }
}

function startSlotScheduler() {
  setInterval(async () => {
    const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const { data } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('status', 'seated')
      .lt('seated_at', cutoff)
      .select('table_id');
    for (const token of data ?? []) {
      if (token.table_id) {
        await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', token.table_id);
      }
    }
  }, 60 * 60 * 1000);

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
}

app.post('/api/catalog/slot-sync', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    const slotOverride = req.body.slot || null;
    const slot         = slotOverride ?? getCurrentSlotIST();
    const validSlots   = SLOTS.map(s => s.dbValue);
    if (slotOverride && !validSlots.includes(slotOverride))
      return res.status(400).json({ error: `Invalid slot. Must be one of: ${validSlots.join(', ')} or null` });
    const result = await applySlotAvailability(req.restaurant_id, slot);
    res.json({
      success: true, ...result,
      ist_hour: Math.floor(((new Date().getUTCHours() * 60 + new Date().getUTCMinutes() + 330) % 1440) / 60),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// CATALOG SYNC
// ============================================================================

async function syncCatalogFromMeta(restaurantId) {
  const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
  const META_CATALOG_ID   = process.env.META_CATALOG_ID;
  if (!META_ACCESS_TOKEN || !META_CATALOG_ID) {
    console.error('Missing META_ACCESS_TOKEN or META_CATALOG_ID');
    return { success: false, error: 'Missing Meta credentials' };
  }
  console.log(`🔄 [catalog-sync] Starting for restaurant ${restaurantId}...`);
  try {
    let allProducts = [];
    let nextUrl = `https://graph.facebook.com/v20.0/${META_CATALOG_ID}/products`
      + `?fields=id,name,description,price,currency,image_url,availability,`
      + `category,retailer_id,custom_label_0`
      + `&limit=100&access_token=${META_ACCESS_TOKEN}`;
    while (nextUrl) {
      const response = await fetch(nextUrl);
      const data     = await response.json();
      if (data.error) throw new Error(`Meta API error: ${data.error.message}`);
      allProducts = [...allProducts, ...(data.data || [])];
      nextUrl = data.paging?.next || null;
    }
    console.log(`  📦 Fetched ${allProducts.length} products from Meta`);
    let synced = 0, skipped = 0;
    const errors = [];
    for (const product of allProducts) {
      try {
        let price = 0;
        if (product.price) {
          if (typeof product.price === 'string') {
            const raw = product.price.trim();
            const hasRupeeSymbol = raw.includes('₹') || raw.toUpperCase().includes('INR');
            const numeric = parseFloat(raw.replace(/[^0-9.]/g, ''));
            if (!isNaN(numeric)) {
              // If the string contains ₹ or INR it's already in rupees (e.g. "₹60.00")
              // Otherwise it's in paise as returned by Meta's raw API (e.g. "6000" = ₹60)
              price = hasRupeeSymbol ? numeric : numeric / 100;
            }
          } else if (typeof product.price === 'number') {
            // Numbers > 100 are almost certainly paise; small numbers are rupees
            price = product.price > 100 ? product.price / 100 : product.price;
          }
          console.log(`[price] raw=${product.price} → ₹${price}`);
        }
        const SLOT_MAP = {
          'morning tiffin': 'morning_tiffin', 'lunch': 'lunch',
          'evening snacks': 'evening_snacks', 'dinner tiffin': 'dinner_tiffin',
        };
        const rawSlot  = (product.custom_label_0 || '').trim().toLowerCase();
        const timeSlot = SLOT_MAP[rawSlot] || 'all';
        const menuItem = {
          restaurant_id:   restaurantId,
          name:            product.name?.trim(),
          description:     product.description?.trim() || '',
          price,
          image_url:       product.image_url || null,
          category:        product.category || 'General',
          time_slot:       timeSlot,
          meta_product_id: product.id,
          retailer_id:     product.retailer_id || product.id,
          updated_at:      new Date().toISOString(),
        };
        const { error } = await supabaseAdmin.from('menu_items')
          .upsert(menuItem, { onConflict: 'restaurant_id,meta_product_id', ignoreDuplicates: false });
        if (error) throw error;
        synced++;
      } catch (itemError) {
        skipped++;
        errors.push({ product_id: product.id, error: itemError.message });
        console.error(`  ⚠️  Skipped product ${product.id}:`, itemError.message);
      }
    }

    // Price sanity check — log any items that still look wrong after sync
    // (safety-net correction loop removed: the price parser now correctly
    // handles both "₹60.00" rupee strings and "6000" paise integers)
    const { data: suspectPrices } = await supabaseAdmin
      .from('menu_items')
      .select('id, name, price')
      .eq('restaurant_id', restaurantId)
      .lt('price', 1);
    if (suspectPrices && suspectPrices.length > 0) {
      console.warn(`[catalog-sync] ⚠️ ${suspectPrices.length} item(s) still have price < ₹1 after sync — check Meta catalog prices:`);
      suspectPrices.forEach(i => console.warn(`  • ${i.name}: ₹${i.price}`));
    }

    await applySlotAvailability(restaurantId, getCurrentSlotIST());
    const result = { success: true, synced, skipped, total: allProducts.length, errors: errors.length > 0 ? errors : undefined };
    console.log(`  ✅ Sync complete:`, result);
    return result;
  } catch (err) {
    console.error('❌ Catalog sync failed:', err);
    return { success: false, error: err.message };
  }
}

app.post('/api/catalog/sync', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    const result = await syncCatalogFromMeta(req.restaurant_id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/catalog/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified');
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Forbidden' });
  }
});

app.post('/api/catalog/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  try {
    const body = req.body;
    if (body.object !== 'product_catalog') return;
    console.log('📨 Meta catalog webhook received — triggering sync');
    const { data: restaurants } = await supabaseAdmin.from('restaurants').select('id').eq('is_active', true);
    for (const r of restaurants ?? []) {
      syncCatalogFromMeta(r.id).catch(err => console.error(`Webhook sync failed for ${r.id}:`, err));
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }
});

async function runStartupSync() {
  console.log('🚀 Running startup catalog sync...');
  try {
    const { data: restaurants } = await supabaseAdmin.from('restaurants').select('id').eq('is_active', true);
    for (const r of restaurants ?? []) { await syncCatalogFromMeta(r.id); }
  } catch (err) {
    console.error('Startup sync error:', err);
  }
}

// ============================================================================
// MENU ITEMS ENDPOINTS
// ============================================================================

app.get('/api/menu-items', authenticateToken, getRestaurantId, async (req, res) => {
  // ignore_slot=true  → manager portal view: returns ALL items across all slots
  //                     and ALL stock states (in/out) so the toggle table is complete
  // ignore_slot=false → customer/bot view: only is_available=true items in current slot
  try {
    const { category, ignore_slot } = req.query;
    const isManagerView = ignore_slot === 'true';

    const now        = new Date();
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const istMinutes = (utcMinutes + 330) % (24 * 60);
    const istHour    = Math.floor(istMinutes / 60);
    let currentSlot;
    if      (istHour >= 6  && istHour < 11) currentSlot = 'morning_tiffin';
    else if (istHour >= 11 && istHour < 15) currentSlot = 'lunch';
    else if (istHour >= 15 && istHour < 19) currentSlot = 'evening_snacks';
    else if (istHour >= 19 && istHour < 23) currentSlot = 'dinner_tiffin';
    else                                    currentSlot = null;

    let query = supabaseAdmin.from('menu_items').select('*')
      .eq('restaurant_id', req.restaurant_id)
      .order('time_slot', { ascending: true })
      .order('name',      { ascending: true });

    if (category) query = query.eq('category', category);

    if (isManagerView) {
      // Manager sees everything: all slots, all stock states.
      // No is_available filter — out-of-stock items must remain visible
      // so the manager can see and re-enable them via the toggle.
      // Sort: in-stock first, then out-of-stock (greyed) at the bottom.
      query = query.order('is_stocked', { ascending: false });
    } else {
      // Customer / bot view: only available items in the current slot
      query = query.eq('is_available', true);
      if (currentSlot) query = query.or(`time_slot.eq.${currentSlot},time_slot.eq.all`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, count: data.length, items: data, current_slot: currentSlot, ist_hour: istHour });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/menu-items', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner')
      return res.status(403).json({ error: 'Unauthorized' });
    const { name, description, price, category } = req.body;
    const { data, error } = await supabaseAdmin.from('menu_items')
      .insert({ restaurant_id: req.restaurant_id, name, description, price, category, is_available: true })
      .select().single();
    if (error) throw error;
    res.json({ success: true, item: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/menu-items/:id/availability', authenticateToken, getRestaurantId, async (req, res) => {
  // Real-time mid-service toggle — used when an item runs out during a slot.
  // Updates is_stocked (permanent manager flag) + is_available immediately,
  // then pushes to Meta catalog so WhatsApp shows the item greyed out at once.
  // No need to wait for the next slot change or Excel upload.
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });

    const { is_available } = req.body;  // boolean from portal toggle
    const isStocked = Boolean(is_available);

    // Update both columns atomically:
    //   is_stocked — persists across slot changes (scheduler respects this)
    //   is_available — immediately reflects current state in the portal/KDS
    const { data, error } = await supabaseAdmin
      .from('menu_items')
      .update({
        is_stocked:   isStocked,
        is_available: isStocked,   // immediate effect; scheduler won't re-enable if false
        updated_at:   new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id)
      .select()
      .single();

    if (error) throw error;

    // Push to Meta catalog immediately (non-blocking) so WhatsApp reflects
    // the change within seconds rather than waiting for the next Excel upload.
    if (data?.retailer_id) {
      const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
      const META_CATALOG_ID   = process.env.META_CATALOG_ID;
      if (META_ACCESS_TOKEN && META_CATALOG_ID) {
        fetch(
          `https://graph.facebook.com/v20.0/${META_CATALOG_ID}/batch`,
          {
            method:  'POST',
            headers: {
              Authorization:  `Bearer ${META_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              allow_upsert: true,
              requests: [{
                method:      'UPDATE',
                retailer_id: data.retailer_id,
                data: {
                  name:         data.name,
                  description:  data.description || '',
                  price:        Math.round((data.price || 0) * 100),
                  currency:     'INR',
                  availability: isStocked ? 'in stock' : 'out of stock',
                  image_url:    data.image_url || '',
                  url:          process.env.FRONTEND_URL || 'https://autom8.works/',
                },
              }],
            }),
          }
        )
        .then(r => r.json())
        .then(result => {
          if (result.error) {
            console.error(`[avail-toggle] Meta push failed for ${data.retailer_id}:`, result.error?.message);
          } else {
            console.log(`[avail-toggle] ✅ Meta updated: ${data.name} → ${isStocked ? 'in stock' : 'out of stock'}`);
          }
        })
        .catch(err => console.error('[avail-toggle] Meta push error:', err.message));
      }
    }

    console.log(`[avail-toggle] ${data?.name} → is_stocked=${isStocked} by manager`);
    res.json({ success: true, item: data });

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// ORDERS ENDPOINTS
// ============================================================================

app.get('/api/orders', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    let query = supabaseAdmin.from('orders')
      .select(`*, table:table_id(table_number, section), order_items(*, menu_item:menu_item_id(name, category))`)
      .eq('restaurant_id', req.restaurant_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, orders: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/orders/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('orders')
      .select(`*, table:table_id(table_number, section), order_items(*, menu_item:menu_item_id(name, category, price)), payments(*)`)
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id).single();
    if (error) throw error;
    res.json({ success: true, order: data });
  } catch (err) {
    res.status(404).json({ error: 'Order not found' });
  }
});

app.post('/api/orders', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner')
      return res.status(403).json({ error: 'Unauthorized' });
    const { table_id, items, notes } = req.body;
    const orderNumber = `ORD-${Date.now()}`;
    const { data: orderData, error: orderError } = await supabaseAdmin.from('orders')
      .insert({ restaurant_id: req.restaurant_id, table_id, order_number: orderNumber, notes, created_by: req.user.sub })
      .select().single();
    if (orderError) throw orderError;
    let subtotal   = 0;
    const orderItems = [];
    for (const item of items) {
      const { data: menuItem } = await supabaseAdmin.from('menu_items')
        .select('price').eq('id', item.menu_item_id).single();
      subtotal += menuItem.price * item.quantity;
      const { data: itemData, error: itemError } = await supabaseAdmin.from('order_items')
        .insert({ order_id: orderData.id, menu_item_id: item.menu_item_id, quantity: item.quantity,
          unit_price: menuItem.price, special_instructions: item.special_instructions })
        .select().single();
      if (itemError) throw itemError;
      orderItems.push(itemData);
      await supabaseAdmin.from('kds_items').insert({
        restaurant_id: req.restaurant_id, order_item_id: itemData.id, status: 'pending',
      });
    }
    const tax = subtotal * 0.1, total = subtotal + tax;
    await supabaseAdmin.from('orders').update({ subtotal, tax, total_amount: total }).eq('id', orderData.id);
    if (table_id) await supabaseAdmin.from('tables').update({ status: 'occupied' }).eq('id', table_id);
    await supabaseAdmin.from('audit_logs').insert({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: 'Order created', details: { order_id: orderData.id, order_number: orderNumber },
    });
    res.json({ success: true, order: { ...orderData, subtotal, tax, total_amount: total, order_items: orderItems } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/orders/:id/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabaseAdmin.from('orders')
      .update({ status }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;
    await supabaseAdmin.from('audit_logs').insert({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: 'Order status updated', details: { order_id: req.params.id, status },
    });
    res.json({ success: true, order: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/orders/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner')
      return res.status(403).json({ error: 'Unauthorized' });
    const { data, error } = await supabaseAdmin.from('orders')
      .update({ status: 'cancelled' }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;
    if (data.table_id) {
      const { data: activeOrders } = await supabaseAdmin.from('orders').select('id')
        .eq('table_id', data.table_id).in('status', ['pending', 'confirmed', 'in_progress']);
      if (!activeOrders || activeOrders.length === 0)
        await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', data.table_id);
    }
    await supabaseAdmin.from('audit_logs').insert({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: 'Order cancelled', details: { order_id: req.params.id },
    });
    res.json({ success: true, order: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// KDS ENDPOINTS
// ============================================================================

app.get('/api/kds/feed', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const statusFilter = status === 'all'
      ? ['pending', 'in_progress', 'ready']
      : [status];
    const { data, error } = await supabaseAdmin.from('kds_items')
      .select(`
        *,
        order_item:order_item_id!left(
          *,
          menu_item:menu_item_id!left(name, description, prep_time_minutes),
          order:order_id!left(
            table:table_id!left(table_number, section),
            order_number
          )
        )
      `)
      .eq('restaurant_id', req.restaurant_id)
      .in('status', statusFilter)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, items: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// SHARED HELPER — notifyOrderReady
// ──────────────────────────────────────────────────────────────────────────────
// Single source of truth for the "order is ready" WhatsApp notification.
// Called by both PUT /api/kds/:id/status (item-by-item path) and
// POST /api/orders/:id/complete (bulk path).
//
// Guard: atomically updates orders.status to 'ready' only if it is currently
// NOT already 'ready'. The update returns 0 rows if the status was already
// set — meaning a concurrent call already won — so we skip the WhatsApp send.
// This prevents duplicate notifications regardless of how many concurrent
// requests arrive.
// ============================================================================

async function notifyOrderReady({ orderId, restaurantId, kdsItem }) {
  try {
    // Atomically claim the notification slot.
    // .eq('status', 'pending') / in_progress / ready is tricky because
    // the order may still be 'pending' at this point.
    // Use .neq('status', 'ready') so only the FIRST caller sets it.
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('orders')
      .update({ status: 'ready' })
      .eq('id', orderId)
      .neq('status', 'ready')        // ← only succeeds once
      .neq('status', 'cancelled')
      .select('order_number, table:table_id!left(table_number), walk_in_tokens(phone)')
      .single();

    if (updateErr || !updated) {
      // Either already ready (duplicate call) or genuinely not found — skip
      console.log(`[notifyOrderReady] Skipped for order ${orderId} — already ready or not found`);
      return;
    }

    // Resolve phone: walk_in_token first, then kds_item fallback
    const phone =
      updated.walk_in_tokens?.[0]?.phone ??
      kdsItem?.customer_phone ??
      null;

    if (phone) {
      await sendWhatsAppMessage(
        phone,
        `✅ *Your order is ready!*\n\n` +
        `Order: *${updated.order_number}*\n` +
        (updated.table?.table_number ? `Table: *${updated.table.table_number}*\n` : '') +
        `\nYour food will be served shortly. Enjoy! 🍽️`
      );
      console.log(`[notifyOrderReady] ✅ Notified ${phone} for order ${orderId}`);
    } else {
      console.log(`[notifyOrderReady] No phone for order ${orderId} — skipping WhatsApp`);
    }

    broadcastToRestaurant(restaurantId, {
      type:         'ORDER_READY',
      order_id:     orderId,
      order_number: updated.order_number,
      table_number: updated.table?.table_number ?? null,
      timestamp:    new Date().toISOString(),
    });

  } catch (err) {
    console.error('[notifyOrderReady] Error:', err.message);
  }
}

app.put('/api/kds/:id/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabaseAdmin.from('kds_items')
      .update({ status })
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;

    if (status === 'ready') {
      try {
        // Fetch the kds_item to resolve order_id and phone
        const { data: kdsItem } = await supabaseAdmin
          .from('kds_items')
          .select('order_item:order_item_id!left(order_id), token_number, customer_phone, service_type')
          .eq('id', req.params.id)
          .single();

        const orderId = kdsItem?.order_item?.order_id;

        if (orderId) {
          // Check if ALL items for this order are now ready
          const { data: allItems } = await supabaseAdmin
            .from('kds_items')
            .select('status, order_item:order_item_id!left(order_id)')
            .eq('restaurant_id', req.restaurant_id);

          const orderItems = (allItems ?? []).filter(i => i.order_item?.order_id === orderId);
          const allReady   = orderItems.length > 0 && orderItems.every(i => i.status === 'ready');

          if (allReady) {
            // Delegate to shared helper — atomically guards against duplicates
            await notifyOrderReady({ orderId, restaurantId: req.restaurant_id, kdsItem });
          }
        }
        // Note: orphaned kds_items with no order_id (legacy data / kds/notify flow)
        // do NOT send notifications here — they have no reliable order to check against.
      } catch (notifyErr) {
        console.error('[KDS ready notify] Failed:', notifyErr.message);
      }
    }

    res.json({ success: true, item: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// MENU UPLOAD ENDPOINT
// ============================================================================

app.post('/api/menu/upload', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });

    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'items array is required and must not be empty' });

    let upserted = 0, skipped = 0;
    const errors = [];

    for (const item of items) {
      try {
        if (!item.id || !item.name) {
          errors.push({ row_id: item.id, error: 'Missing id or name' });
          skipped++;
          continue;
        }

        const price = parseFloat(item.price) || 0;
        if (price <= 0) {
          errors.push({ row_id: item.id, error: `Invalid price: ${item.price}` });
          skipped++;
          continue;
        }

        // is_available column in Excel → maps to is_stocked in the DB.
        // is_stocked is the permanent manager flag; is_available is slot-managed.
        // Accepts: TRUE/FALSE, 1/0, yes/no (case-insensitive). Absent = true.
        let isStocked = true;
        if (item.is_available !== undefined && item.is_available !== null && item.is_available !== '') {
          const raw = String(item.is_available).toLowerCase().trim();
          isStocked = raw === 'true' || raw === '1' || raw === 'yes';
        }

        const menuItem = {
          restaurant_id: req.restaurant_id,
          id:            item.id,
          name:          String(item.name).trim(),
          description:   String(item.description || '').trim(),
          price,
          image_url:     item.image_url ? String(item.image_url).trim() : null,
          time_slot:     item.time_slot || 'all',
          category:      item.category || 'General',
          is_stocked:    isStocked,
          // is_available stays untouched — slot scheduler manages it.
          // But if marking out of stock, immediately reflect it:
          ...(isStocked === false ? { is_available: false } : {}),
          updated_at:    new Date().toISOString(),
        };

        const { error: upsertError } = await supabaseAdmin
          .from('menu_items')
          .upsert(menuItem, { onConflict: 'restaurant_id,id', ignoreDuplicates: false });

        if (upsertError) {
          errors.push({ row_id: item.id, error: upsertError.message });
          skipped++;
          continue;
        }

        upserted++;
      } catch (itemError) {
        errors.push({ row_id: item.id, error: itemError.message });
        skipped++;
      }
    }

    // Re-apply current slot so newly stocked items activate immediately
    try {
      const currentSlot = getCurrentSlotIST();
      if (currentSlot) await applySlotAvailability(req.restaurant_id, currentSlot);
    } catch (slotErr) {
      console.warn('[menu/upload] Slot re-apply failed (non-fatal):', slotErr.message);
    }

    await supabaseAdmin.from('audit_logs').insert({
      user_id: req.user.sub,
      restaurant_id: req.restaurant_id,
      action: 'Menu items uploaded via Excel',
      details: { upserted, skipped, total: items.length, error_count: errors.length },
    }).catch(() => {});

    const response = { success: true, upserted, skipped, total: items.length };
    if (errors.length > 0) response.errors = errors;

    console.log(`[menu/upload] ✅ ${upserted} upserted, ${skipped} skipped for restaurant ${req.restaurant_id}`);

    // Push to Meta catalog in background so WhatsApp shows updated availability
    pushMenuToMeta(req.restaurant_id).catch(err =>
      console.error('[menu/upload] Meta push failed (non-fatal):', err.message)
    );

    res.json(response);

  } catch (err) {
    console.error('[menu/upload] Unexpected error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PUSH DB → META CATALOG
//
// Called after /api/menu/upload. Keeps the WhatsApp catalog in sync with DB.
//
// Availability mapping (what customers see in WhatsApp):
//   is_stocked = true  → 'in stock'     shown and orderable normally
//   is_stocked = false → 'out of stock' shown greyed out, cannot add to cart
//
// Excel column: is_available (TRUE/FALSE). Maps to is_stocked in DB.
// The WhatsApp catalog always shows all items — out-of-stock ones are visible
// with an "Unavailable" label so customers know the item exists.
// ============================================================================

async function pushMenuToMeta(restaurantId) {
  const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
  const META_CATALOG_ID   = process.env.META_CATALOG_ID;
  if (!META_ACCESS_TOKEN || !META_CATALOG_ID) {
    console.warn('[meta-push] Skipped — META_ACCESS_TOKEN or META_CATALOG_ID not set');
    return { success: false };
  }

  const { data: items, error } = await supabaseAdmin
    .from('menu_items')
    .select('name, description, price, image_url, retailer_id, is_stocked')
    .eq('restaurant_id', restaurantId)
    .not('retailer_id', 'is', null);

  if (error || !items?.length) {
    console.warn('[meta-push] No items to push');
    return { success: false };
  }

  const BATCH_SIZE  = 100;
  let   totalPushed = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch    = items.slice(i, i + BATCH_SIZE);
    const requests = batch.map(item => ({
      method:      'UPDATE',
      retailer_id: item.retailer_id,
      data: {
        name:         item.name,
        description:  item.description || '',
        price:        Math.round((item.price || 0) * 100),  // paise
        currency:     'INR',
        availability: item.is_stocked ? 'in stock' : 'out of stock',
        image_url:    item.image_url || '',
        url:          process.env.FRONTEND_URL || 'https://autom8.works/',
      },
    }));

    const resp = await fetch(
      `https://graph.facebook.com/v20.0/${META_CATALOG_ID}/batch`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ allow_upsert: true, requests }),
      }
    );

    const result = await resp.json();
    if (resp.ok) {
      totalPushed += batch.length;
      console.log(`[meta-push] ✅ Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} items pushed`);
    } else {
      console.error(`[meta-push] ❌ Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, JSON.stringify(result).slice(0, 300));
    }
  }

  console.log(`[meta-push] Done — ${totalPushed}/${items.length} items pushed to Meta catalog`);
  return { success: true, count: totalPushed };
}

// ============================================================================
// Fix 9 — POST /api/orders/:id/complete
// Atomic "mark all items ready" endpoint that:
//   • Bulk-updates every kds_item for this order to 'ready' in one DB call
//   • Updates the order status to 'ready'
//   • Fires exactly ONE WhatsApp notification (no race condition)
//   • Broadcasts one ORDER_READY WebSocket event
//   • Is idempotent — safe to call if some items are already ready
// Used by the KDS "Mark all ready" button instead of N parallel PUTs.
// ============================================================================

app.post('/api/orders/:id/complete', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const orderId = req.params.id;

    // 1. Verify order belongs to this restaurant
    const { data: order, error: orderFetchError } = await supabaseAdmin
      .from('orders')
      .select(`
        id,
        order_number,
        status,
        restaurant_id,
        table:table_id!left(table_number),
        walk_in_tokens(phone)
      `)
      .eq('id', orderId)
      .eq('restaurant_id', req.restaurant_id)
      .single();

    if (orderFetchError || !order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status === 'completed' || order.status === 'cancelled') {
      return res.status(400).json({ error: `Order is already ${order.status}` });
    }

    // 2. Fetch all kds_items for this order via join
    const { data: kdsItems, error: kdsFetchError } = await supabaseAdmin
      .from('kds_items')
      .select('id, status, order_item:order_item_id!left(order_id), customer_phone, token_number')
      .eq('restaurant_id', req.restaurant_id);

    if (kdsFetchError) throw kdsFetchError;

    const orderKdsItems = (kdsItems ?? []).filter(
      i => i.order_item?.order_id === orderId
    );

    if (orderKdsItems.length === 0) {
      return res.status(404).json({ error: 'No KDS items found for this order' });
    }

    // 3. Bulk-update all non-cancelled items to 'ready'
    const activeItems    = orderKdsItems.filter(i => i.status !== 'cancelled');
    const alreadyAllDone = activeItems.every(i => i.status === 'ready');

    if (!alreadyAllDone) {
      const itemIds = activeItems.map(i => i.id);
      const { error: bulkUpdateError } = await supabaseAdmin
        .from('kds_items')
        .update({ status: 'ready' })
        .in('id', itemIds)
        .eq('restaurant_id', req.restaurant_id);

      if (bulkUpdateError) throw bulkUpdateError;
    }

    // 4+5+6. Update order status, send WhatsApp, broadcast — all via shared
    // notifyOrderReady() which atomically guards against duplicate sends.
    // The .neq('status','ready') guard inside notifyOrderReady means only
    // the first caller (PUT item or POST /complete) ever sends the message.
    const firstKdsItem = orderKdsItems.find(i => i.customer_phone) ?? orderKdsItems[0];
    await notifyOrderReady({
      orderId,
      restaurantId: req.restaurant_id,
      kdsItem: firstKdsItem,
    });

    // 7. Audit log (non-fatal)
    await supabaseAdmin.from('audit_logs').insert({
      user_id:       req.user.sub,
      restaurant_id: req.restaurant_id,
      action:        'Order marked ready via /complete',
      details: {
        order_id:          orderId,
        order_number:      order.order_number,
        kds_items_updated: alreadyAllDone ? 0 : activeItems.length,
      },
    }).catch(() => {});

    res.json({
      success:           true,
      order_id:          orderId,
      order_number:      order.order_number,
      kds_items_updated: alreadyAllDone ? 0 : activeItems.length,
    });

  } catch (err) {
    console.error('[POST /api/orders/:id/complete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// TABLES ENDPOINTS
// ============================================================================

app.get('/api/tables', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('tables').select('*')
      .eq('restaurant_id', req.restaurant_id).order('table_number', { ascending: true });
    if (error) throw error;
    res.json({ success: true, tables: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/tables/:id/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabaseAdmin.from('tables')
      .update({ status }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;
    res.json({ success: true, table: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// PAYMENTS ENDPOINTS
// ============================================================================

app.post('/api/payments', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner')
      return res.status(403).json({ error: 'Unauthorized' });
    const { order_id, amount, payment_method } = req.body;
    const { data, error } = await supabaseAdmin.from('payments')
      .insert({ restaurant_id: req.restaurant_id, order_id, amount, payment_method, status: 'completed', processed_by: req.user.sub })
      .select().single();
    if (error) throw error;
    await supabaseAdmin.from('orders').update({ payment_status: 'paid', status: 'completed' }).eq('id', order_id);
    const { data: order } = await supabaseAdmin.from('orders').select('table_id').eq('id', order_id).single();
    if (order.table_id) await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', order.table_id);
    await supabaseAdmin.from('audit_logs').insert({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: 'Payment processed', details: { order_id, amount, method: payment_method },
    });
    res.json({ success: true, payment: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// REPORTS ENDPOINTS
// ============================================================================

app.get('/api/reports/sales', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    const { date } = req.query;
    const reportDate = date || new Date().toISOString().split('T')[0];
    const { data, error } = await supabaseAdmin.from('orders')
      .select('id, total_amount, status, created_at, order_items(menu_item:menu_item_id(category))')
      .eq('restaurant_id', req.restaurant_id)
      .gte('created_at', `${reportDate}T00:00:00`)
      .lt('created_at',  `${reportDate}T23:59:59`)
      .eq('status', 'completed');
    if (error) throw error;
    const totalRevenue  = data.reduce((sum, o) => sum + (o.total_amount || 0), 0);
    const totalOrders   = data.length;
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const categoryBreakdown = {};
    data.forEach(order => {
      order.order_items?.forEach(item => {
        const cat = item.menu_item?.category || 'Other';
        categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;
      });
    });
    res.json({ success: true, report: { date: reportDate, totalOrders, totalRevenue, avgOrderValue, categoryBreakdown } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// WALK-IN TOKEN SYSTEM
// ============================================================================

async function generateTokenId(restaurantId) {
  const { data: allTokens } = await supabaseAdmin
    .from('walk_in_tokens')
    .select('id')
    .eq('restaurant_id', restaurantId);

  let maxSeq = 0;
  for (const row of allTokens ?? []) {
    const match = String(row.id).match(/^T-(\d+)$/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > maxSeq) maxSeq = n;
    }
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    const seq       = maxSeq + 1 + attempt;
    const candidate = `T-${String(seq).padStart(3, '0')}`;

    const { data: existing } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('id')
      .eq('id', candidate)
      .maybeSingle();

    if (!existing) {
      console.log(`[generateTokenId] Generated: ${candidate}`);
      return candidate;
    }
    console.warn(`[generateTokenId] ${candidate} taken, trying next...`);
  }

  return `T-${Date.now().toString().slice(-6)}`;
}

app.post('/api/tokens', async (req, res) => {
  // Fix 10 — accepts type='large_party' with status='pending_approval'
  // and a meta.combo array describing the proposed table split.
  try {
    const { name, phone, type, pax, restaurant_id, meta } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!type)                 return res.status(400).json({ error: 'type is required' });
    if (!restaurant_id)        return res.status(400).json({ error: 'restaurant_id is required' });

    const validTypes = ['dinein', 'takeaway', 'large_party'];
    if (!validTypes.includes(type))
      return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });

    const tokenId = await generateTokenId(restaurant_id);

    let status;
    if (type === 'large_party') status = 'pending_approval';
    else if (type === 'takeaway') status = 'takeaway';
    else status = 'waiting';

    const tokenRecord = {
      id:         tokenId,
      restaurant_id,
      name:       name.trim(),
      phone:      phone ? String(phone).replace(/\D/g, '') : null,
      type,
      pax:        type === 'takeaway' ? 1 : (parseInt(pax) || 1),
      status,
      arrived_at: new Date().toISOString(),
      meta:       meta || {},
    };

    const { data: token, error: insertError } = await supabaseAdmin
      .from('walk_in_tokens').insert(tokenRecord).select().single();
    if (insertError) throw insertError;

    const arrivalTime = new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
    });

    if (type === 'large_party') {
      // Notify manager immediately — they must approve before customer is seated
      if (process.env.MANAGER_WHATSAPP_NUMBER && process.env.WHATSAPP_ACCESS_TOKEN) {
        const combo      = meta?.combo ?? [];
        const tableLines = combo.length > 0
          ? combo.map(t => `Table ${t[0]} (${t[2]}/${t[1]} seats)`).join(' + ')
          : `${token.pax} seats across multiple tables`;
        const managerMsg =
          `🟣 *Large Party Request* — Token *${token.id}*\n` +
          `👥 ${token.name} · *${token.pax} people*\n` +
          `🕐 ${arrivalTime}\n\n` +
          `Proposed seating:\n${tableLines}\n\n` +
          `⚠️ *Action required* — approve or reject in the portal:\n` +
          `${process.env.FRONTEND_URL || 'https://autom8-frontend-production.up.railway.app'}/dashboard/manager`;
        sendWhatsAppMessage(process.env.MANAGER_WHATSAPP_NUMBER, managerMsg);
      }
    } else {
      // Normal walk-in — notify manager (suppressed for munafe bot via ?notify=false)
      const skipNotify = req.query.notify === 'false';
      if (!skipNotify && process.env.MANAGER_WHATSAPP_NUMBER && process.env.WHATSAPP_ACCESS_TOKEN) {
        const typeLabel = type === 'dinein' ? 'Dine-in' : 'Takeaway';
        const paxLine   = type === 'dinein' ? `, ${token.pax} ${token.pax === 1 ? 'person' : 'people'}` : '';
        const managerMsg =
          `🪑 *New Walk-in* — Token *${token.id}*\n` +
          `👤 ${token.name}${paxLine}\n` +
          `📋 ${typeLabel}\n` +
          `🕐 ${arrivalTime}\n\n` +
          `Open portal to assign table:\n` +
          `${process.env.FRONTEND_URL || 'https://autom8-frontend-production.up.railway.app'}/dashboard/manager`;
        sendWhatsAppMessage(process.env.MANAGER_WHATSAPP_NUMBER, managerMsg);
      }
    }

    broadcastToRestaurant(restaurant_id, { type: 'NEW_TOKEN', token, timestamp: new Date().toISOString() });
    res.status(201).json({ success: true, token });
  } catch (err) {
    console.error('[POST /api/tokens]', err);
    res.status(500).json({ error: err.message || 'Failed to create token' });
  }
});

app.get('/api/tokens', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status } = req.query;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    console.log(`[GET /api/tokens] restaurant_id=${req.restaurant_id} status=${status || 'all'} from=${todayStart.toISOString()}`);

    let query;
    if (status) {
      query = supabaseAdmin.from('walk_in_tokens').select('*')
        .eq('restaurant_id', req.restaurant_id)
        .eq('status', status)
        .gte('arrived_at', todayStart.toISOString())
        .order('arrived_at', { ascending: true });
    } else {
      query = supabaseAdmin.from('walk_in_tokens').select('*')
        .eq('restaurant_id', req.restaurant_id)
        .or(`status.in.(waiting,seated,takeaway,pending_approval),and(status.eq.completed,arrived_at.gte.${todayStart.toISOString()})`)
        .order('arrived_at', { ascending: true });
    }

    const { data, error } = await query;
    if (error) {
      console.error('[GET /api/tokens] Query error:', error.message);
      throw error;
    }

    console.log(`[GET /api/tokens] Found ${data?.length ?? 0} token(s) for restaurant ${req.restaurant_id}`);
    res.json({ success: true, tokens: data || [] });
  } catch (err) {
    console.error('[GET /api/tokens]', err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/tokens/:id', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('id, name, phone, status, type, pax, table_number, table_id, arrived_at, seated_at')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Token not found' });
    res.json({ success: true, token: data });
  } catch (err) {
    console.error('[GET /api/tokens/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Fix 10 — PUT /api/tokens/:id/approve
// ============================================================================

app.put('/api/tokens/:id/approve', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    const { data: token, error: fetchError } = await supabaseAdmin
      .from('walk_in_tokens').select('*')
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id).single();
    if (fetchError || !token) return res.status(404).json({ error: 'Token not found' });
    if (token.status !== 'pending_approval')
      return res.status(400).json({ error: `Token is ${token.status}, not pending_approval` });
    const { data: updatedToken, error: updateError } = await supabaseAdmin
      .from('walk_in_tokens').update({ status: 'waiting' })
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id).select().single();
    if (updateError) throw updateError;
    const combo = token.meta?.combo ?? [];
    const tableLines = combo.length > 0
      ? combo.map(t => `Table ${t[0]} (${t[2]} seats)`).join(', ')
      : 'multiple tables';
    if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
      await sendWhatsAppMessage(token.phone,
        `✅ *Great news! Your large party request has been approved.*\n\n` +
        `Token: *${token.id}*\nParty of: *${token.pax} people*\n` +
        `Tables reserved: *${tableLines}*\n\n` +
        `Please head to the restaurant — our staff will seat your party shortly. 🍽️`
      );
    }
    broadcastToRestaurant(req.restaurant_id, { type: 'TOKEN_APPROVED', token: updatedToken, timestamp: new Date().toISOString() });
    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id: req.user.sub, restaurant_id: req.restaurant_id,
        action: 'Large party token approved', details: { token_id: req.params.id, pax: token.pax, combo },
      });
    } catch (_) { /* audit log is non-fatal */ }
    console.log(`[approve] ✅ Token ${token.id} approved for ${token.pax} guests`);
    res.json({ success: true, token: updatedToken });
  } catch (err) {
    console.error('[PUT /api/tokens/:id/approve]', err);
    res.status(500).json({ error: err.message || 'Failed to approve token' });
  }
});

// ============================================================================
// Fix 10 — PUT /api/tokens/:id/reject
// ============================================================================

app.put('/api/tokens/:id/reject', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    const { reason } = req.body;
    const { data: token, error: fetchError } = await supabaseAdmin
      .from('walk_in_tokens').select('*')
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id).single();
    if (fetchError || !token) return res.status(404).json({ error: 'Token not found' });
    if (token.status !== 'pending_approval')
      return res.status(400).json({ error: `Token is ${token.status}, not pending_approval` });
    const { data: updatedToken, error: updateError } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id).select().single();
    if (updateError) throw updateError;
    if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
      const reasonLine = reason ? `\n\nReason: ${reason}` : '';
      await sendWhatsAppMessage(token.phone,
        `😔 *We're sorry — we're unable to accommodate your party of ${token.pax} right now.*` +
        reasonLine + `\n\nWe'd love to host you! Reply *RESERVE* to book for a future date. 🙏`
      );
    }
    broadcastToRestaurant(req.restaurant_id, { type: 'TOKEN_REJECTED', token: updatedToken, timestamp: new Date().toISOString() });
    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id: req.user.sub, restaurant_id: req.restaurant_id,
        action: 'Large party token rejected', details: { token_id: req.params.id, pax: token.pax, reason: reason || null },
      });
    } catch (_) { /* audit log is non-fatal */ }
    console.log(`[reject] Token ${token.id} rejected for ${token.pax} guests`);
    res.json({ success: true, token: updatedToken });
  } catch (err) {
    console.error('[PUT /api/tokens/:id/reject]', err);
    res.status(500).json({ error: err.message || 'Failed to reject token' });
  }
});



app.put('/api/tokens/:id/assign', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { table_id, table_number } = req.body;
    if (!table_id || !table_number)
      return res.status(400).json({ error: 'table_id and table_number are required' });

    const { data: token, error: fetchError } = await supabaseAdmin
      .from('walk_in_tokens').select('*')
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id).single();
    if (fetchError || !token) return res.status(404).json({ error: 'Token not found' });
    if (token.status !== 'waiting')
      return res.status(400).json({ error: `Token is already ${token.status}` });

    const { data: updatedToken, error: updateError } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({ status: 'seated', table_id, table_number, seated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (updateError) throw updateError;

    await supabaseAdmin.from('tables').update({ status: 'occupied' })
      .eq('id', table_id).eq('restaurant_id', req.restaurant_id);

    if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
      const customerMsg =
        `✅ *Your table is ready!*\n\n` +
        `Token: *${token.id}*\n` +
        `Table: *Table ${table_number}*\n\n` +
        `Please proceed to your table and browse our menu to place your order. Enjoy your meal! 🍽️`;
      await sendWhatsAppMessage(token.phone, customerMsg);
      console.log(`[assign] Sending catalog to ${token.phone}`);
      await sendWhatsAppCatalogMessage(token.phone, req.restaurant_id);
      console.log(`[assign] Catalog sent`);
    }

    broadcastToRestaurant(req.restaurant_id, {
      type: 'TOKEN_ASSIGNED', token: updatedToken, timestamp: new Date().toISOString(),
    });

    await supabaseAdmin.from('audit_logs').insert({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: 'Token assigned to table', details: { token_id: req.params.id, table_id, table_number },
    });

    res.json({ success: true, token: updatedToken });
  } catch (err) {
    console.error('[PUT /api/tokens/:id/assign]', err);
    res.status(500).json({ error: err.message || 'Failed to assign table' });
  }
});

app.put('/api/tokens/:id/complete', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data: token, error: fetchError } = await supabaseAdmin
      .from('walk_in_tokens').select('*')
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id).single();
    if (fetchError || !token) return res.status(404).json({ error: 'Token not found' });

    const { data: updatedToken, error: updateError } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (updateError) throw updateError;

    if (token.table_id) {
      const { data: activeOrders } = await supabaseAdmin.from('orders').select('id')
        .eq('table_id', token.table_id).in('status', ['pending', 'confirmed', 'in_progress']);
      if (!activeOrders || activeOrders.length === 0)
        await supabaseAdmin.from('tables').update({ status: 'available' })
          .eq('id', token.table_id).eq('restaurant_id', req.restaurant_id);
    }

    broadcastToRestaurant(req.restaurant_id, {
      type: 'TOKEN_COMPLETED', token: updatedToken, timestamp: new Date().toISOString(),
    });
    res.json({ success: true, token: updatedToken });
  } catch (err) {
    console.error('[PUT /api/tokens/:id/complete]', err);
    res.status(500).json({ error: err.message || 'Failed to complete token' });
  }
});

app.delete('/api/tokens/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('walk_in_tokens')
      .delete().eq('id', req.params.id).eq('restaurant_id', req.restaurant_id);
    if (error) throw error;
    res.json({ success: true, message: 'Token dismissed' });
  } catch (err) {
    console.error('[DELETE /api/tokens/:id]', err);
    res.status(500).json({ error: err.message || 'Failed to dismiss token' });
  }
});

// ============================================================================
// WHATSAPP ORDER WEBHOOK
// ============================================================================

app.get('/api/whatsapp/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ [WA Webhook] Verified');
    return res.status(200).send(challenge);
  }
  console.warn('[WA Webhook] Verification failed — token mismatch');
  res.status(403).json({ error: 'Forbidden' });
});

app.post('/api/whatsapp/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const value    = change.value;
        const metadata = value.metadata;
        for (const message of value.messages ?? []) {
          console.log(`[WA Webhook] Message type: ${message.type} from ${message.from}`);
          if (message.type === 'order') {
            await handleWhatsAppOrder(message, metadata).catch(err =>
              console.error('[WA Webhook] handleWhatsAppOrder failed:', err.message)
            );
          }
          await supabaseAdmin.from('audit_logs').insert({
            action: 'WhatsApp message received',
            details: {
              type: message.type, from: message.from,
              phone_number_id: metadata?.phone_number_id, message_id: message.id,
            },
          }).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('[WA Webhook] Top-level error:', err.message);
  }
});

async function handleWhatsAppOrder(message, metadata) {
  const customerPhone = message.from;
  const productItems  = message.order?.product_items ?? [];
  console.log(`[WA Order] 📦 From ${customerPhone}, items: ${productItems.length}`);
  if (productItems.length === 0) { console.warn('[WA Order] Empty product_items — skipping'); return; }

  let restaurantId = process.env.DEFAULT_RESTAURANT_ID || null;
  if (metadata?.phone_number_id) {
    const { data: restaurant } = await supabaseAdmin.from('restaurants').select('id')
      .eq('whatsapp_phone_number_id', metadata.phone_number_id).eq('is_active', true).single();
    if (restaurant) restaurantId = restaurant.id;
  }
  if (!restaurantId) { console.error('[WA Order] Could not resolve restaurant'); return; }

  const normalizedPhone = String(customerPhone).replace(/\D/g, '');
  const { data: token } = await supabaseAdmin.from('walk_in_tokens').select('*')
    .eq('restaurant_id', restaurantId).eq('phone', normalizedPhone).eq('status', 'seated')
    .order('seated_at', { ascending: false }).limit(1).maybeSingle();

  if (!token) {
    console.warn(`[WA Order] No seated token found for phone ${normalizedPhone}`);
    await sendWhatsAppMessage(customerPhone, `⚠️ We couldn't find your table assignment.\nPlease ask a staff member for help.`);
    return;
  }

  const orderNumber = `ORD-WA-${Date.now()}`;
  const { data: orderData, error: orderError } = await supabaseAdmin.from('orders')
    .insert({ restaurant_id: restaurantId, table_id: token.table_id, order_number: orderNumber, status: 'pending', source: 'whatsapp' })
    .select().single();
  if (orderError) { console.error('[WA Order] Failed to create order:', orderError.message); return; }

  let subtotal = 0;
  const kdsInserts  = [];
  const skippedOos  = [];   // items rejected because is_stocked=false
  for (const item of productItems) {
    const { data: menuItem } = await supabaseAdmin.from('menu_items').select('id, name, price, is_stocked, is_available')
      .eq('restaurant_id', restaurantId).eq('retailer_id', item.product_retailer_id).maybeSingle();
    if (!menuItem) { console.warn(`[WA Order] ⚠️ No menu item for retailer_id: ${item.product_retailer_id}`); continue; }
    // Reject out-of-stock items — Meta catalog may still show them as orderable
    // due to caching even after we pushed 'out of stock'. Enforce here at order time.
    if (menuItem.is_stocked === false || menuItem.is_available === false) {
      console.warn(`[WA Order] ⛔ ${menuItem.name} is out of stock — skipping`);
      skippedOos.push(menuItem.name);
      continue;
    }
    subtotal += menuItem.price * item.quantity;
    const { data: orderItem, error: itemError } = await supabaseAdmin.from('order_items')
      .insert({ order_id: orderData.id, menu_item_id: menuItem.id, quantity: item.quantity, unit_price: menuItem.price })
      .select().single();
    if (itemError) { console.error(`[WA Order] order_item insert failed:`, itemError.message); continue; }
    kdsInserts.push({ restaurant_id: restaurantId, order_item_id: orderItem.id, status: 'pending', priority: 'normal', item_name: menuItem.name });
  }

  if (kdsInserts.length > 0) {
    const { error: kdsError } = await supabaseAdmin.from('kds_items').insert(kdsInserts);
    if (kdsError) console.error('[WA Order] KDS insert failed:', kdsError.message);
    else console.log(`[WA Order] ✅ ${kdsInserts.length} KDS item(s) created — kitchen notified`);
  }

  const tax = subtotal * 0.1, total = subtotal + tax;
  await supabaseAdmin.from('orders').update({ subtotal, tax, total_amount: total }).eq('id', orderData.id);

  broadcastToRestaurant(restaurantId, {
    type: 'ORDER_NEW', order_id: orderData.id, order_number: orderNumber,
    table_number: token.table_number, source: 'whatsapp',
    item_count: kdsInserts.length, timestamp: new Date().toISOString(),
  });

  if (process.env.MANAGER_WHATSAPP_NUMBER) {
    const itemLines = productItems.map(i => `• ${i.quantity}x ${i.product_retailer_id}`).join('\n');
    await sendWhatsAppMessage(process.env.MANAGER_WHATSAPP_NUMBER,
      `🍽️ *New WhatsApp Order*\nOrder: *${orderNumber}*\nTable: *${token.table_number}*\nCustomer: ${token.name}\n\n${itemLines}\n\nTotal: ₹${total.toFixed(2)}`
    );
  }

  const oosWarning = skippedOos.length > 0
    ? `\n\n⚠️ *Sorry, the following items were out of stock and could not be added:*\n${skippedOos.map(n => `• ${n}`).join('\n')}`
    : '';
  await sendWhatsAppMessage(customerPhone,
    `✅ *Order received!*\n\nOrder: *${orderNumber}*\nTable: *Table ${token.table_number}*\nItems: ${kdsInserts.length}${oosWarning}\n\nWe're preparing your food now. We'll notify you when it's ready! 🍳`
  );
  await supabaseAdmin.from('audit_logs').insert({
    restaurant_id: restaurantId, action: 'WhatsApp order created',
    details: { order_id: orderData.id, order_number: orderNumber, phone: normalizedPhone, item_count: kdsInserts.length },
  }).catch(() => {});
}

// ============================================================================
// KDS INTERNAL NOTIFY ENDPOINT
// ============================================================================

app.post('/api/kds/notify', async (req, res) => {
  try {
    const {
      secret, restaurant_id, customer_name, customer_phone,
      token_number, table_number, service_type, special_notes, items,
    } = req.body;

    const expected = process.env.AUTOM8_KDS_SECRET || 'munafe_kds_sync_2026';
    if (secret !== expected) return res.status(403).json({ error: 'Forbidden' });
    if (!restaurant_id || !items || items.length === 0)
      return res.status(400).json({ error: 'restaurant_id and items are required' });

    const orderNumber = `ORD-WA-${Date.now()}`;

    let tableId = null;
    if (table_number) {
      const { data: tableRow } = await supabaseAdmin.from('tables').select('id')
        .eq('restaurant_id', restaurant_id).eq('table_number', String(table_number)).maybeSingle();
      if (tableRow) tableId = tableRow.id;
    }

    const { data: orderData, error: orderError } = await supabaseAdmin.from('orders')
      .insert({ restaurant_id, table_id: tableId, order_number: orderNumber, status: 'pending', source: 'whatsapp' })
      .select().single();
    if (orderError) {
      console.error('[kds-notify] Order insert failed:', orderError.message);
      return res.status(500).json({ error: orderError.message });
    }

    let subtotal   = 0;
    let kdsCreated = 0;
    const kdsInserts = [];

    for (const item of items) {
      let menuItemId    = null;
      let resolvedPrice = item.unit_price || 0;

      if (item.retailer_id && item.retailer_id !== 'manual') {
        const { data: menuItem } = await supabaseAdmin.from('menu_items').select('id, price')
          .eq('restaurant_id', restaurant_id).eq('retailer_id', item.retailer_id).maybeSingle();
        if (menuItem) { menuItemId = menuItem.id; resolvedPrice = menuItem.price; }
      }

      subtotal += resolvedPrice * (item.qty || 1);

      const { data: orderItem, error: itemError } = await supabaseAdmin.from('order_items')
        .insert({
          order_id: orderData.id, menu_item_id: menuItemId,
          quantity: item.qty || 1, unit_price: resolvedPrice,
          special_instructions: item.name,
        })
        .select().single();

      if (itemError) { console.error(`[kds-notify] order_item insert failed for ${item.name}:`, itemError.message); continue; }

      kdsInserts.push({
        restaurant_id,
        order_item_id:        orderItem.id,
        status:               'pending',
        priority:             'normal',
        special_instructions: special_notes || null,
        item_name:            item.name,
        token_number:         token_number   || null,
        customer_phone:       customer_phone || null,
        service_type:         service_type   || null,
      });
    }

    if (kdsInserts.length > 0) {
      const { error: kdsError } = await supabaseAdmin.from('kds_items').insert(kdsInserts);
      if (kdsError) {
        console.error('[kds-notify] kds_items insert failed:', kdsError.message);
      } else {
        kdsCreated = kdsInserts.length;
        console.log(`[kds-notify] ✅ ${kdsCreated} KDS item(s) created — order ${orderNumber}`);
      }
    }

    const tax = subtotal * 0.1, total = subtotal + tax;
    await supabaseAdmin.from('orders').update({ subtotal, tax, total_amount: total }).eq('id', orderData.id);

    broadcastToRestaurant(restaurant_id, {
      type: 'ORDER_NEW', order_id: orderData.id, order_number: orderNumber,
      token_number, table_number: table_number || null, customer_name,
      service_type: service_type || 'whatsapp', kds_items_count: kdsCreated,
      special_notes: special_notes || null, source: 'whatsapp',
      timestamp: new Date().toISOString(),
    });

    try {
      await supabaseAdmin.from('audit_logs').insert({
        restaurant_id, action: 'KDS notified via WhatsApp order',
        details: { order_id: orderData.id, order_number: orderNumber, token_number, table_number, customer_phone, kds_items_created: kdsCreated, special_notes: special_notes || null },
      });
    } catch (_) { /* non-fatal */ }

    res.json({ success: true, order_id: orderData.id, order_number: orderNumber, kds_items_created: kdsCreated });

  } catch (err) {
    console.error('[kds-notify] Unexpected error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// SUBSCRIPTION / FEATURE FLAGS
// ============================================================================

app.get('/api/subscription', authenticateToken, getRestaurantId, async (req, res) => {
  res.json({
    success: true,
    plan: 'pro',
    features: [
      'dine_in', 'takeaway', 'delivery', 'reserve_table',
      'token_management', 'kds', 'analytics', 'marketing',
      'whatsapp_ordering', 'catalog_sync', 'reporting',
    ],
    valid_until: null,
  });
});

// ============================================================================
// OWNER DASHBOARD — MUNAFE CHAT PROXY ENDPOINTS
// ============================================================================

app.get('/api/dashboard/waba', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!supabaseChat) {
      return res.status(503).json({ error: 'Munafe Chat not configured. Add MUNAFE_CHAT_SUPABASE_URL and MUNAFE_CHAT_SERVICE_ROLE_KEY env vars.' });
    }
    let data = null;
    const { data: byId } = await supabaseChat
      .from('restaurants')
      .select('id, name, whatsapp_number, manager_phone, timezone, dining_duration_minutes, payment_mode, waba_id')
      .eq('id', req.restaurant_id)
      .maybeSingle();
    data = byId;

    if (!data) {
      const { data: first } = await supabaseChat
        .from('restaurants')
        .select('id, name, whatsapp_number, manager_phone, timezone, dining_duration_minutes, payment_mode, waba_id')
        .limit(1)
        .maybeSingle();
      data = first;
    }

    res.json({ success: true, restaurant: data ?? null });
  } catch (err) {
    console.error('[GET /api/dashboard/waba]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/wa-orders', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!supabaseChat) {
      return res.status(503).json({ error: 'Munafe Chat not configured.' });
    }
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end query params required' });

    const { data: sample } = await supabaseChat
      .from('bookings')
      .select('*')
      .limit(1)
      .maybeSingle();

    const cols = sample ? Object.keys(sample) : [];
    console.log('[wa-orders] bookings columns:', cols.join(', ') || 'table empty or missing');

    const dateCol     = cols.includes('created_at')    ? 'created_at'
                      : cols.includes('booking_datetime') ? 'booking_datetime'
                      : 'created_at';
    const amountCol   = cols.includes('token_advance') ? 'token_advance'
                      : cols.includes('total_amount')  ? 'total_amount'
                      : null;
    const hasCustomer = cols.includes('customer_id');
    const hasRestId   = cols.includes('restaurant_id');

    const selectParts = [
      'id', dateCol, 'service_type', 'status', 'party_size',
      'token_number', 'payment_status', 'booking_datetime',
    ];
    if (amountCol)   selectParts.push(amountCol);
    if (hasCustomer) selectParts.push('customer_id, customers(name, phone)');

    let q = supabaseChat
      .from('bookings')
      .select(selectParts.join(', '))
      .gte(dateCol, start)
      .lte(dateCol, end)
      .order(dateCol, { ascending: false })
      .limit(500);

    if (hasRestId) q = q.eq('restaurant_id', req.restaurant_id);

    const { data, error } = await q;

    if (error) {
      console.error('[wa-orders] query failed:', error.message);
      const { data: minimal } = await supabaseChat
        .from('bookings')
        .select(`id, ${dateCol}, service_type, status, party_size, token_number`)
        .gte(dateCol, start)
        .lte(dateCol, end)
        .order(dateCol, { ascending: false })
        .limit(500);
      const minData = minimal ?? [];
      console.log(`[wa-orders] Minimal fallback: ${minData.length} rows`);
      return res.json({ success: true, orders: minData.map(r => ({ ...r, created_at: r[dateCol] })) });
    }

    let finalData = data ?? [];
    if (finalData.length === 0 && hasRestId) {
      console.log('[wa-orders] Restaurant filter returned 0 — trying without restaurant filter...');
      const { data: allData } = await supabaseChat
        .from('bookings')
        .select(selectParts.join(', '))
        .gte(dateCol, start)
        .lte(dateCol, end)
        .order(dateCol, { ascending: false })
        .limit(500);
      finalData = allData ?? [];
      console.log(`[wa-orders] Without restaurant filter: ${finalData.length} bookings`);
    }

    const normalized = finalData.map(r => ({
      ...r,
      created_at:   r[dateCol]   ?? r.created_at,
      total_amount: amountCol ? (r[amountCol] ?? null) : null,
    }));
    console.log(`[wa-orders] Returning ${normalized.length} bookings`);
    return res.json({ success: true, orders: normalized });
  } catch (err) {
    console.error('[GET /api/dashboard/wa-orders]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/cancel-stats', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const [cancelRes, totalRes] = await Promise.all([
      supabaseAdmin.from('orders')
        .select('total_amount')
        .eq('restaurant_id', req.restaurant_id)
        .eq('status', 'cancelled')
        .gte('created_at', start)
        .lte('created_at', end),
      supabaseAdmin.from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('restaurant_id', req.restaurant_id)
        .gte('created_at', start)
        .lte('created_at', end),
    ]);

    const orderCancels  = cancelRes.data ?? [];
    const totalOrders   = totalRes.count ?? 0;
    const orderRevLost  = orderCancels.reduce((s, o) => s + (o.total_amount ?? 0), 0);

    let bookingCancels = 0, totalBookings = 0;
    if (supabaseChat) {
      const [bcRes, btRes] = await Promise.all([
        supabaseChat.from('bookings')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'cancelled')
          .gte('created_at', start)
          .lte('created_at', end),
        supabaseChat.from('bookings')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', start)
          .lte('created_at', end),
      ]);
      bookingCancels = bcRes.count ?? 0;
      totalBookings  = btRes.count ?? 0;
    }

    res.json({
      success: true,
      orderCancels:  orderCancels.length,
      orderRevLost,
      totalOrders,
      orderRate: totalOrders > 0 ? Math.round((orderCancels.length / totalOrders) * 100) : 0,
      bookingCancels,
      totalBookings,
      bookingRate: totalBookings > 0 ? Math.round((bookingCancels / totalBookings) * 100) : 0,
    });
  } catch (err) {
    console.error('[GET /api/dashboard/cancel-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PUBLIC RESTAURANT RESOLVER
// ============================================================================

app.get('/api/restaurant/default', async (req, res) => {
  try {
    const { data: restaurants, error } = await supabaseAdmin
      .from('restaurants')
      .select('id')
      .eq('is_active', true)
      .limit(2);

    if (error) throw error;

    if (!restaurants || restaurants.length === 0) {
      return res.status(404).json({ error: 'No active restaurant found' });
    }

    if (restaurants.length > 1) {
      return res.status(400).json({
        error: 'Multiple restaurants found. QR code URL must include ?restaurant=<id>'
      });
    }

    res.json({ restaurant_id: restaurants[0].id });
  } catch (err) {
    console.error('[GET /api/restaurant/default]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// WEBSOCKET
// ============================================================================

const clients = new Map();

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
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
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });
  ws.on('close', () => {
    if (restaurantId && clients.has(restaurantId)) {
      const list  = clients.get(restaurantId);
      const index = list.indexOf(ws);
      if (index > -1) list.splice(index, 1);
    }
    console.log('WebSocket client disconnected');
  });
  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

function broadcastToRestaurant(restaurantId, data) {
  if (clients.has(restaurantId)) {
    clients.get(restaurantId).forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  }
}

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`\n🚀 Autom8 Backend Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🗄️  Database: ${process.env.SUPABASE_URL}\n`);
  startSlotScheduler();
  runStartupSync();
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => console.log('HTTP server closed'));
});

module.exports = { app, wss, broadcastToRestaurant };
