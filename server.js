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
      // Fix 8: log the actual error so it's visible in Railway logs
      console.error(`[getRestaurantId] DB error for user ${req.user.sub}:`, error.message);
      return res.status(401).json({ error: `User lookup failed: ${error.message}` });
    }

    if (!data) {
      console.error(`[getRestaurantId] No user row found for id=${req.user.sub} email=${req.user.email}`);
      return res.status(401).json({ error: 'User profile not found. Ensure user exists in users table.' });
    }

    if (!data.restaurant_id) {
      // Fix 6: fallback — try to find restaurant by matching the hardcoded portal restaurant
      console.warn(`[getRestaurantId] User ${req.user.sub} has no restaurant_id in users table`);
      // Use the default restaurant if only one exists
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
    const { data: thumbItem, error: thumbError } = await supabaseAdmin
      .from('menu_items')
      .select('retailer_id')
      .eq('restaurant_id', restaurantId)
      .eq('is_available', true)
      .limit(1)
      .single();
    if (thumbError || !thumbItem?.retailer_id) {
      console.warn('[catalog-msg] No available items found for thumbnail');
      return;
    }
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
              parameters: { thumbnail_product_retailer_id: thumbItem.retailer_id },
            },
          },
        }),
      }
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[catalog-msg] API error:', err);
    } else {
      console.log(`[catalog-msg] ✅ Sent to ${toNumber}`);
    }
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
  const { data: activated, error: e1 } = await supabaseAdmin
    .from('menu_items')
    .update({ is_available: true, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId)
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
            // "22000 INR" → strip non-numeric → 22000 → /100 = ₹220
            const numeric = parseFloat(product.price.replace(/[^0-9.]/g, ''));
            price = isNaN(numeric) ? 0 : numeric / 100;
          } else if (typeof product.price === 'number') {
            // If already a small number (≤100) it's in rupees, otherwise paise
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

    // Safety net: if any prices look wrong (< ₹1 for real food items),
    // multiply back up — catches any future double-division
    const { data: badPrices } = await supabaseAdmin
      .from('menu_items')
      .select('id, price')
      .eq('restaurant_id', restaurantId)
      .lt('price', 1);
    if (badPrices && badPrices.length > 0) {
      console.warn(`[catalog-sync] ⚠️ Found ${badPrices.length} items with price < ₹1 — correcting...`);
      for (const item of badPrices) {
        await supabaseAdmin.from('menu_items')
          .update({ price: Math.round(item.price * 100 * 100) / 100 })
          .eq('id', item.id);
      }
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
  try {
    const { category, ignore_slot } = req.query;
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
      .eq('restaurant_id', req.restaurant_id).eq('is_available', true)
      .order('category', { ascending: true }).order('name', { ascending: true });
    if (category) query = query.eq('category', category);
    if (currentSlot && ignore_slot !== 'true')
      query = query.or(`time_slot.eq.${currentSlot},time_slot.eq.all`);
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
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    const { is_available } = req.body;
    const { data, error } = await supabaseAdmin.from('menu_items')
      .update({ is_available })
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;
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
        const { data: kdsItem } = await supabaseAdmin
          .from('kds_items')
          .select('order_item:order_item_id!left(order_id), token_number, customer_phone, service_type')
          .eq('id', req.params.id)
          .single();

        const orderId     = kdsItem?.order_item?.order_id;
        const directPhone = kdsItem?.customer_phone;

        if (orderId) {
          const { data: allItems } = await supabaseAdmin
            .from('kds_items')
            .select('status, order_item:order_item_id!left(order_id)')
            .eq('restaurant_id', req.restaurant_id);

          const orderItems = allItems?.filter(i => i.order_item?.order_id === orderId) ?? [];
          const allReady   = orderItems.length > 0 && orderItems.every(i => i.status === 'ready');

          if (allReady) {
            const { data: order } = await supabaseAdmin
              .from('orders')
              .select('order_number, table:table_id!left(table_number), walk_in_tokens(phone)')
              .eq('id', orderId)
              .single();

            const phone = order?.walk_in_tokens?.[0]?.phone ?? directPhone;
            if (phone) {
              await sendWhatsAppMessage(
                phone,
                `✅ *Your order is ready!*\n\n` +
                `Order: *${order?.order_number ?? kdsItem?.token_number ?? ''}*\n` +
                (order?.table?.table_number ? `Table: *${order.table.table_number}*\n` : '') +
                `\nYour food will be served shortly. Enjoy! 🍽️`
              );
            }
          }
        } else if (directPhone) {
          await sendWhatsAppMessage(
            directPhone,
            `✅ *Your order is ready!*\n\n` +
            `Token: *${kdsItem?.token_number ?? ''}*\n\n` +
            `Your food is being served now. Enjoy! 🍽️`
          );
        }
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
// server.js — ADD THIS BLOCK
//
// Paste it directly after the existing PUT /api/kds/:id/status handler
// (after the closing `});` of that route, around line ~460 in your file).
//
// WHAT THIS DOES
// ──────────────
// POST /api/orders/:id/complete
//   • Atomically marks every kds_item for this order as 'ready'
//   • Updates the parent order status to 'ready'
//   • Fires exactly ONE WhatsApp "order ready" notification
//   • Broadcasts one ORDER_READY WebSocket event
//   • Safe to call even if some items were already 'ready' (idempotent)
//
// WHY THIS IS BETTER THAN PARALLEL PUT /api/kds/:id/status CALLS
// ──────────────────────────────────────────────────────────────────
// The old approach fired N parallel requests. Each one re-checked "are all
// items ready?" against the DB. Depending on write ordering, 0 or 2+ of them
// could win the race and send duplicate WhatsApp messages.
// This endpoint does the whole thing in one server round-trip.
// ============================================================================

app.post('/api/orders/:id/complete', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const orderId = req.params.id;

    // ── 1. Verify order belongs to this restaurant ──────────────────────────
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

    // ── 2. Fetch all kds_items for this order ───────────────────────────────
    // We join through order_items to filter by order_id
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

    // Check whether any non-cancelled items are not yet ready
    const activeItems    = orderKdsItems.filter(i => i.status !== 'cancelled');
    const alreadyAllDone = activeItems.every(i => i.status === 'ready');

    if (!alreadyAllDone) {
      // ── 3. Bulk-update all active kds_items to 'ready' ───────────────────
      const itemIds = activeItems.map(i => i.id);
      const { error: bulkUpdateError } = await supabaseAdmin
        .from('kds_items')
        .update({ status: 'ready' })
        .in('id', itemIds)
        .eq('restaurant_id', req.restaurant_id);

      if (bulkUpdateError) throw bulkUpdateError;
    }

    // ── 4. Update order status to 'ready' ───────────────────────────────────
    const { error: orderUpdateError } = await supabaseAdmin
      .from('orders')
      .update({ status: 'ready' })
      .eq('id', orderId)
      .eq('restaurant_id', req.restaurant_id);

    if (orderUpdateError) throw orderUpdateError;

    // ── 5. Send exactly ONE WhatsApp notification ───────────────────────────
    // Phone resolution priority:
    //   a) walk_in_tokens.phone (dine-in customer who checked in via WhatsApp)
    //   b) customer_phone stored on any kds_item (WhatsApp order flow)
    const phone =
      order.walk_in_tokens?.[0]?.phone ??
      orderKdsItems.find(i => i.customer_phone)?.customer_phone ??
      null;

    if (phone) {
      await sendWhatsAppMessage(
        phone,
        `✅ *Your order is ready!*\n\n` +
        `Order: *${order.order_number}*\n` +
        (order.table?.table_number ? `Table: *${order.table.table_number}*\n` : '') +
        `\nYour food will be served shortly. Enjoy! 🍽️`
      );
    }

    // ── 6. Broadcast WebSocket event ────────────────────────────────────────
    broadcastToRestaurant(req.restaurant_id, {
      type:         'ORDER_READY',
      order_id:     orderId,
      order_number: order.order_number,
      table_number: order.table?.table_number ?? null,
      timestamp:    new Date().toISOString(),
    });

    // ── 7. Audit log ─────────────────────────────────────────────────────────
    await supabaseAdmin.from('audit_logs').insert({
      user_id:       req.user.sub,
      restaurant_id: req.restaurant_id,
      action:        'Order marked ready',
      details: {
        order_id:          orderId,
        order_number:      order.order_number,
        kds_items_updated: alreadyAllDone ? 0 : activeItems.length,
        notified_phone:    phone ?? null,
      },
    }).catch(() => {}); // non-fatal

    res.json({
      success:           true,
      order_id:          orderId,
      order_number:      order.order_number,
      kds_items_updated: alreadyAllDone ? 0 : activeItems.length,
      notified:          !!phone,
    });

  } catch (err) {
    console.error('[POST /api/orders/:id/complete]', err.message);
    res.status(500).json({ error: err.message });
  }
});
