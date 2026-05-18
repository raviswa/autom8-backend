// ============================================================================
// AUTOM8 BACKEND - MAIN SERVER
// server.js
//
// FIX LOG
// ------
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
          price = typeof product.price === 'string'
            ? parseFloat(product.price.replace(/[^0-9.]/g, '')) / 100
            : product.price / 100;
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
// Fix 6: GET /api/tokens now logs clearly why tokens may be empty
// ============================================================================

async function generateTokenId(restaurantId) {
  // Fix: use ALL-TIME count to avoid duplicate key collisions with existing tokens.
  // Previous approach used today-only count which always returned 0 since existing
  // tokens were created on prior days, causing T-001 duplicate key errors.
  let attempts = 0;
  while (attempts < 10) {
    const { count, error } = await supabaseAdmin
      .from('walk_in_tokens').select('*', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId);
    if (error) console.error('[generateTokenId] count query failed:', error.message);
    const seq = (count ?? 0) + 1 + attempts;
    const candidate = `T-${String(seq).padStart(3, '0')}`;
    // Verify this ID doesn't already exist
    const { data: existing } = await supabaseAdmin
      .from('walk_in_tokens').select('id').eq('id', candidate).maybeSingle();
    if (!existing) {
      console.log(`[generateTokenId] Generated: ${candidate} (attempt ${attempts + 1})`);
      return candidate;
    }
    console.warn(`[generateTokenId] ${candidate} already exists, trying next...`);
    attempts++;
  }
  // Final fallback: timestamp-based ID
  return `T-${Date.now().toString().slice(-6)}`;
}

// POST /api/tokens — public, called by WhatsApp bot and WalkInForm
app.post('/api/tokens', async (req, res) => {
  try {
    const { name, phone, type, pax, restaurant_id } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!type)                 return res.status(400).json({ error: 'type is required (dinein or takeaway)' });
    if (!restaurant_id)        return res.status(400).json({ error: 'restaurant_id is required' });
    if (!['dinein', 'takeaway'].includes(type))
      return res.status(400).json({ error: 'type must be dinein or takeaway' });

    const tokenId = await generateTokenId(restaurant_id);
    const status  = type === 'takeaway' ? 'takeaway' : 'waiting';
    const tokenRecord = {
      id: tokenId, restaurant_id, name: name.trim(),
      phone: phone ? String(phone).replace(/\D/g, '') : null,
      type, pax: type === 'takeaway' ? 1 : (parseInt(pax) || 1),
      status, arrived_at: new Date().toISOString(),
    };
    const { data: token, error: insertError } = await supabaseAdmin
      .from('walk_in_tokens').insert(tokenRecord).select().single();
    if (insertError) throw insertError;

    if (process.env.MANAGER_WHATSAPP_NUMBER && process.env.WHATSAPP_ACCESS_TOKEN) {
      const arrivalTime = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      const typeLabel   = type === 'dinein' ? 'Dine-in' : 'Takeaway';
      const paxLine     = type === 'dinein' ? `, ${token.pax} ${token.pax === 1 ? 'person' : 'people'}` : '';
      const managerMsg  =
        `🪑 *New Walk-in* — Token *${token.id}*\n` +
        `👤 ${token.name}${paxLine}\n` +
        `📋 ${typeLabel}\n` +
        `🕐 ${arrivalTime}\n\n` +
        `Open portal to assign table:\n${process.env.FRONTEND_URL || 'https://autom8-frontend-production.up.railway.app'}/dashboard/manager`;
      sendWhatsAppMessage(process.env.MANAGER_WHATSAPP_NUMBER, managerMsg);
    }

    broadcastToRestaurant(restaurant_id, { type: 'NEW_TOKEN', token, timestamp: new Date().toISOString() });
    res.status(201).json({ success: true, token });
  } catch (err) {
    console.error('[POST /api/tokens]', err);
    res.status(500).json({ error: err.message || 'Failed to create token' });
  }
});

// GET /api/tokens — authenticated, manager portal queue
// Fix 6+7: verbose logging so Railway logs show exactly why queue is empty
app.get('/api/tokens', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status } = req.query;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    console.log(`[GET /api/tokens] restaurant_id=${req.restaurant_id} status=${status || 'all'} from=${todayStart.toISOString()}`);

    // Show active tokens (waiting/seated/takeaway) regardless of date,
    // PLUS completed tokens from today only (for audit trail)
    let query;
    if (status) {
      // Specific status requested — filter by it, today only
      query = supabaseAdmin.from('walk_in_tokens').select('*')
        .eq('restaurant_id', req.restaurant_id)
        .eq('status', status)
        .gte('arrived_at', todayStart.toISOString())
        .order('arrived_at', { ascending: true });
    } else {
      // No status filter — show all active tokens (any date) + today's completed
      query = supabaseAdmin.from('walk_in_tokens').select('*')
        .eq('restaurant_id', req.restaurant_id)
        .or(`status.in.(waiting,seated,takeaway),and(status.eq.completed,arrived_at.gte.${todayStart.toISOString()})`)
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
  const kdsInserts = [];
  for (const item of productItems) {
    const { data: menuItem } = await supabaseAdmin.from('menu_items').select('id, name, price')
      .eq('restaurant_id', restaurantId).eq('retailer_id', item.product_retailer_id).maybeSingle();
    if (!menuItem) { console.warn(`[WA Order] ⚠️ No menu item for retailer_id: ${item.product_retailer_id}`); continue; }
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

  await sendWhatsAppMessage(customerPhone,
    `✅ *Order received!*\n\nOrder: *${orderNumber}*\nTable: *Table ${token.table_number}*\nItems: ${kdsInserts.length}\n\nWe're preparing your food now. We'll notify you when it's ready! 🍳`
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
