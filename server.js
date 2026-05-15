// ============================================================================
// AUTOM8 BACKEND - MAIN SERVER
// server.js
// ============================================================================
// This is the main entry point for the backend API
// Install: npm install express cors dotenv supabase ws jsonwebtoken bcrypt
// Run: npm run dev (development) or npm start (production)

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Load environment variables
dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize Supabase - TWO clients needed:
// 1. supabase (anon key) - for user-facing auth (signInWithPassword, refreshSession)
// 2. supabaseAdmin (service_role key) - for all DB queries (bypasses RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5173',
    process.env.FRONTEND_URL
  ].filter(Boolean),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.options('*', cors());
app.use(express.json());

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    // Use Supabase to verify the token - no JWT secret needed
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    req.user = { sub: user.id, email: user.email };
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Authentication failed' });
  }
};

// Middleware to get restaurant_id from authenticated user
const getRestaurantId = async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('restaurant_id, role')
      .eq('id', req.user.sub)
      .single();

    if (error) throw error;

    req.restaurant_id = data.restaurant_id;
    req.user_role = data.role;
    next();
  } catch (err) {
    res.status(401).json({ error: 'User not found' });
  }
};

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

// Sign up
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, full_name, restaurant_id, role = 'kitchen_staff' } = req.body;

    // Create auth user (admin client needed for createUser)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: false
    });

    if (authError) throw authError;

    // Create user record
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .insert({
        id: authData.user.id,
        email,
        full_name,
        restaurant_id,
        role
      })
      .select()
      .single();

    if (userError) throw userError;

    // Log signup
    await supabaseAdmin.from('audit_logs').insert({
      user_id: authData.user.id,
      restaurant_id,
      action: 'User signup',
      details: { email, role }
    });

    res.json({ 
      success: true, 
      user: userData 
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Use anon client for user auth sign-in
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;

    // Use admin client for DB queries
    const { data: userDetails } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single();

    if (!userDetails) {
      return res.status(401).json({ error: 'User account not fully set up. No profile found.' });
    }

    // Update last login
    await supabaseAdmin
      .from('users')
      .update({ last_login: new Date() })
      .eq('id', data.user.id);

    // Log login
    await supabaseAdmin.from('audit_logs').insert({
      user_id: data.user.id,
      restaurant_id: userDetails.restaurant_id,
      action: 'User login',
      ip_address: req.ip
    });

    res.json({
      success: true,
      user: userDetails,
      token: data.session.access_token,
      refreshToken: data.session.refresh_token
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// Refresh token
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    // Use anon client for session refresh
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken
    });

    if (error) throw error;

    res.json({
      success: true,
      token: data.session.access_token,
      refreshToken: data.session.refresh_token
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ============================================================================
// SLOT SCHEDULER — owns is_available
// Runs SQL updates at slot boundaries to activate/deactivate items by time_slot
// ============================================================================

const SLOTS = [
  { startHour: 6,  endHour: 11, dbValue: 'morning_tiffin'  },
  { startHour: 11, endHour: 15, dbValue: 'lunch'           },
  { startHour: 15, endHour: 19, dbValue: 'evening_snacks'  },
  { startHour: 19, endHour: 23, dbValue: 'dinner_tiffin'   },
];

function getCurrentSlotIST() {
  const now        = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMinutes = (utcMinutes + 330) % (24 * 60);   // +5h30m
  const istHour    = Math.floor(istMinutes / 60);

  const slot = SLOTS.find(s => istHour >= s.startHour && istHour < s.endHour);
  return slot ? slot.dbValue : null;   // null = closed (23:00–05:59 IST)
}

async function applySlotAvailability(restaurantId, slotDbValue) {
  console.log(`⏰ [${new Date().toISOString()}] Applying slot: ${slotDbValue ?? 'CLOSED'} for restaurant ${restaurantId}`);

  if (!slotDbValue) {
    // Outside service hours — mark everything unavailable
    const { error } = await supabaseAdmin
      .from('menu_items')
      .update({ is_available: false, updated_at: new Date().toISOString() })
      .eq('restaurant_id', restaurantId);

    if (error) throw error;
    console.log(`  ✅ All items set unavailable (closed hours)`);
    return { available: 0, unavailable: 'all' };
  }

  // 1. Activate current slot + always-on items
  const { data: activated, error: e1 } = await supabaseAdmin
    .from('menu_items')
    .update({ is_available: true, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId)
    .in('time_slot', [slotDbValue, 'all'])
    .select('id');

  if (e1) throw e1;

  // 2. Deactivate everything else (other slots)
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
    .from('restaurants')
    .select('id')
    .eq('is_active', true);

  if (error) {
    console.error('Failed to fetch restaurants:', error);
    return;
  }

  for (const r of restaurants ?? []) {
    try {
      await applySlotAvailability(r.id, slot);
    } catch (err) {
      console.error(`  ❌ Failed for restaurant ${r.id}:`, err.message);
    }
  }
}

function startSlotScheduler() {
  let lastAppliedSlot = Symbol('init');  // force run on startup

  // Run immediately on startup to set correct slot right away
  applySlotForAllRestaurants();

  // Then check every 60 seconds — only re-runs when the slot actually changes
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

// Manual trigger endpoint
app.post('/api/catalog/slot-sync', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const slotOverride = req.body.slot || null;
    const slot = slotOverride ?? getCurrentSlotIST();

    const validSlots = SLOTS.map(s => s.dbValue);
    if (slotOverride && !validSlots.includes(slotOverride)) {
      return res.status(400).json({
        error: `Invalid slot. Must be one of: ${validSlots.join(', ')} or null`
      });
    }

    const result = await applySlotAvailability(req.restaurant_id, slot);

    res.json({
      success: true,
      ...result,
      ist_hour: Math.floor(((new Date().getUTCHours() * 60 + new Date().getUTCMinutes() + 330) % 1440) / 60),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// CATALOG SYNC — owns item data (name, price, image), NEVER is_available
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
    // Fetch all products from Meta
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

    // Upsert each product — item data only, never is_available
    let synced   = 0;
    let skipped  = 0;
    const errors = [];

    for (const product of allProducts) {
      try {
        let price = 0;
        if (product.price) {
          price = typeof product.price === 'string'
            ? parseFloat(product.price.replace(/[^0-9.]/g, '')) / 100
            : product.price / 100;
        }

        // Map custom_label_0 → time_slot DB value
        const SLOT_MAP = {
          'morning tiffin': 'morning_tiffin',
          'lunch':          'lunch',
          'evening snacks': 'evening_snacks',
          'dinner tiffin':  'dinner_tiffin',
        };
        const rawSlot  = (product.custom_label_0 || '').trim().toLowerCase();
        const timeSlot = SLOT_MAP[rawSlot] || 'all';

        // NO is_available field — slot scheduler manages it
        const menuItem = {
          restaurant_id:   restaurantId,
          name:            product.name?.trim(),
          description:     product.description?.trim() || '',
          price:           price,
          image_url:       product.image_url  || null,
          category:        product.category   || 'General',
          time_slot:       timeSlot,
          meta_product_id: product.id,
          retailer_id:     product.retailer_id || product.id,
          updated_at:      new Date().toISOString(),
        };

        const { error } = await supabaseAdmin
          .from('menu_items')
          .upsert(menuItem, {
            onConflict:       'restaurant_id,meta_product_id',
            ignoreDuplicates: false,
          });

        if (error) throw error;
        synced++;

      } catch (itemError) {
        skipped++;
        errors.push({ product_id: product.id, error: itemError.message });
        console.error(`  ⚠️  Skipped product ${product.id}:`, itemError.message);
      }
    }

    // After sync: re-apply current slot availability for newly inserted items
    await applySlotAvailability(restaurantId, getCurrentSlotIST());

    const result = {
      success: true,
      synced,
      skipped,
      total:   allProducts.length,
      errors:  errors.length > 0 ? errors : undefined,
    };

    console.log(`  ✅ Sync complete:`, result);
    return result;

  } catch (err) {
    console.error('❌ Catalog sync failed:', err);
    return { success: false, error: err.message };
  }
}

// Manual sync trigger
app.post('/api/catalog/sync', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const result = await syncCatalogFromMeta(req.restaurant_id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Meta webhook
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

    const { data: restaurants } = await supabaseAdmin
      .from('restaurants')
      .select('id')
      .eq('is_active', true);

    for (const r of restaurants ?? []) {
      syncCatalogFromMeta(r.id).catch(err =>
        console.error(`Webhook sync failed for ${r.id}:`, err)
      );
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }
});

// Startup sync
async function runStartupSync() {
  console.log('🚀 Running startup catalog sync...');
  try {
    const { data: restaurants } = await supabaseAdmin
      .from('restaurants')
      .select('id')
      .eq('is_active', true);

    for (const r of restaurants ?? []) {
      await syncCatalogFromMeta(r.id);
    }
  } catch (err) {
    console.error('Startup sync error:', err);
  }
}

// ============================================================================
// MENU ITEMS ENDPOINTS
// ============================================================================

// Get all menu items with slot filtering
app.get('/api/menu-items', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { category, ignore_slot } = req.query;

    // Determine current IST time slot
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

    let query = supabaseAdmin
      .from('menu_items')
      .select('*')
      .eq('restaurant_id', req.restaurant_id)
      .eq('is_available', true)
      .order('category',  { ascending: true })
      .order('name',      { ascending: true });

    if (category) {
      query = query.eq('category', category);
    }

    // Slot filter (skip if ?ignore_slot=true or outside service hours)
    if (currentSlot && ignore_slot !== 'true') {
      query = query.or(`time_slot.eq.${currentSlot},time_slot.eq.all`);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({
      success:      true,
      count:        data.length,
      items:        data,
      current_slot: currentSlot,
      ist_hour:     istHour,
    });

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Create menu item
app.post('/api/menu-items', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const { name, description, price, category } = req.body;
    const { data, error } = await supabaseAdmin
      .from('menu_items')
      .insert({ restaurant_id: req.restaurant_id, name, description, price, category, is_available: true })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, item: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Toggle item availability
app.put('/api/menu-items/:id/availability', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { is_available } = req.body;

    const { data, error } = await supabaseAdmin
      .from('menu_items')
      .update({ is_available })
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, item: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// ORDERS ENDPOINTS
// ============================================================================

// Get all orders for restaurant
app.get('/api/orders', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    let query = supabaseAdmin
      .from('orders')
      .select(`
        *,
        table:table_id(table_number, section),
        order_items(
          *,
          menu_item:menu_item_id(name, category)
        )
      `)
      .eq('restaurant_id', req.restaurant_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, orders: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get single order
app.get('/api/orders/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select(`
        *,
        table:table_id(table_number, section),
        order_items(
          *,
          menu_item:menu_item_id(name, category, price)
        ),
        payments(*)
      `)
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id)
      .single();

    if (error) throw error;

    res.json({ success: true, order: data });
  } catch (err) {
    res.status(404).json({ error: 'Order not found' });
  }
});

// Create order
app.post('/api/orders', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { table_id, items, notes } = req.body;
    const orderNumber = `ORD-${Date.now()}`;

    const { data: orderData, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        restaurant_id: req.restaurant_id,
        table_id,
        order_number: orderNumber,
        notes,
        created_by: req.user.sub
      })
      .select()
      .single();

    if (orderError) throw orderError;

    let subtotal = 0;
    const orderItems = [];

    for (const item of items) {
      const { data: menuItem } = await supabaseAdmin
        .from('menu_items')
        .select('price')
        .eq('id', item.menu_item_id)
        .single();

      subtotal += menuItem.price * item.quantity;

      const { data: itemData, error: itemError } = await supabaseAdmin
        .from('order_items')
        .insert({
          order_id: orderData.id,
          menu_item_id: item.menu_item_id,
          quantity: item.quantity,
          unit_price: menuItem.price,
          special_instructions: item.special_instructions
        })
        .select()
        .single();

      if (itemError) throw itemError;
      orderItems.push(itemData);

      await supabaseAdmin.from('kds_items').insert({
        restaurant_id: req.restaurant_id,
        order_item_id: itemData.id,
        status: 'pending'
      });
    }

    const tax = subtotal * 0.1;
    const total = subtotal + tax;

    await supabaseAdmin
      .from('orders')
      .update({ subtotal, tax, total_amount: total })
      .eq('id', orderData.id);

    if (table_id) {
      await supabaseAdmin
        .from('tables')
        .update({ status: 'occupied' })
        .eq('id', table_id);
    }

    await supabaseAdmin.from('audit_logs').insert({
      user_id: req.user.sub,
      restaurant_id: req.restaurant_id,
      action: 'Order created',
      details: { order_id: orderData.id, order_number: orderNumber }
    });

    res.json({ 
      success: true, 
      order: { ...orderData, subtotal, tax, total_amount: total, order_items: orderItems }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update order status
app.put('/api/orders/:id/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status } = req.body;

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ status })
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id)
      .select()
      .single();

    if (error) throw error;

    await supabaseAdmin.from('audit_logs').insert({
      user_id: req.user.sub,
      restaurant_id: req.restaurant_id,
      action: 'Order status updated',
      details: { order_id: req.params.id, status }
    });

    res.json({ success: true, order: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Cancel order
app.delete('/api/orders/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ status: 'cancelled' })
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id)
      .select()
      .single();

    if (error) throw error;

    if (data.table_id) {
      const { data: activeOrders } = await supabaseAdmin
        .from('orders')
        .select('id')
        .eq('table_id', data.table_id)
        .in('status', ['pending', 'confirmed', 'in_progress']);

      if (!activeOrders || activeOrders.length === 0) {
        await supabaseAdmin
          .from('tables')
          .update({ status: 'available' })
          .eq('id', data.table_id);
      }
    }

    await supabaseAdmin.from('audit_logs').insert({
      user_id: req.user.sub,
      restaurant_id: req.restaurant_id,
      action: 'Order cancelled',
      details: { order_id: req.params.id }
    });

    res.json({ success: true, order: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// KDS (KITCHEN DISPLAY SYSTEM) ENDPOINTS
// ============================================================================

app.get('/api/kds/feed', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status = 'pending' } = req.query;

    const { data, error } = await supabaseAdmin
      .from('kds_items')
      .select(`
        *,
        order_item:order_item_id(
          *,
          menu_item:menu_item_id(name, description, prep_time_minutes),
          order:order_id(table:table_id(table_number, section))
        )
      `)
      .eq('restaurant_id', req.restaurant_id)
      .in('status', status === 'all' ? ['pending', 'in_progress', 'ready'] : [status])
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

    const { data, error } = await supabaseAdmin
      .from('kds_items')
      .update({ status })
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id)
      .select()
      .single();

    if (error) throw error;

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
    const { data, error } = await supabaseAdmin
      .from('tables')
      .select('*')
      .eq('restaurant_id', req.restaurant_id)
      .order('table_number', { ascending: true });

    if (error) throw error;

    res.json({ success: true, tables: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/tables/:id/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status } = req.body;

    const { data, error } = await supabaseAdmin
      .from('tables')
      .update({ status })
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id)
      .select()
      .single();

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
    if (req.user_role !== 'manager' && req.user_role !== 'owner') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { order_id, amount, payment_method } = req.body;

    const { data, error } = await supabaseAdmin
      .from('payments')
      .insert({
        restaurant_id: req.restaurant_id,
        order_id,
        amount,
        payment_method,
        status: 'completed',
        processed_by: req.user.sub
      })
      .select()
      .single();

    if (error) throw error;

    await supabaseAdmin
      .from('orders')
      .update({ payment_status: 'paid', status: 'completed' })
      .eq('id', order_id);

    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('table_id')
      .eq('id', order_id)
      .single();

    if (order.table_id) {
      await supabaseAdmin
        .from('tables')
        .update({ status: 'available' })
        .eq('id', order.table_id);
    }

    await supabaseAdmin.from('audit_logs').insert({
      user_id: req.user.sub,
      restaurant_id: req.restaurant_id,
      action: 'Payment processed',
      details: { order_id, amount, method: payment_method }
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
    if (req.user_role !== 'owner' && req.user_role !== 'manager') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { date } = req.query;
    const reportDate = date || new Date().toISOString().split('T')[0];

    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('id, total_amount, status, created_at, order_items(menu_item:menu_item_id(category))')
      .eq('restaurant_id', req.restaurant_id)
      .gte('created_at', `${reportDate}T00:00:00`)
      .lt('created_at', `${reportDate}T23:59:59`)
      .eq('status', 'completed');

    if (error) throw error;

    const totalRevenue = data.reduce((sum, order) => sum + (order.total_amount || 0), 0);
    const totalOrders = data.length;
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    const categoryBreakdown = {};
    data.forEach(order => {
      order.order_items?.forEach(item => {
        const category = item.menu_item?.category || 'Other';
        categoryBreakdown[category] = (categoryBreakdown[category] || 0) + 1;
      });
    });

    res.json({
      success: true,
      report: { date: reportDate, totalOrders, totalRevenue, avgOrderValue, categoryBreakdown }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// WEBSOCKET - REAL-TIME UPDATES
// ============================================================================

const clients = new Map();

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  
  let userId = null;
  let restaurantId = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'SUBSCRIBE') {
        userId = data.userId;
        restaurantId = data.restaurantId;
        
        if (!clients.has(restaurantId)) {
          clients.set(restaurantId, []);
        }
        clients.get(restaurantId).push(ws);
        
        ws.send(JSON.stringify({
          type: 'SUBSCRIBED',
          restaurantId,
          timestamp: new Date().toISOString()
        }));
      }
    } catch (err) {
      console.error('WebSocket error:', err);
    }
  });

  ws.on('close', () => {
    if (restaurantId && clients.has(restaurantId)) {
      const clientList = clients.get(restaurantId);
      const index = clientList.indexOf(ws);
      if (index > -1) {
        clientList.splice(index, 1);
      }
    }
    console.log('WebSocket client disconnected');
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
  
  // Start schedulers
  startSlotScheduler();
  runStartupSync();
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

module.exports = { app, wss, broadcastToRestaurant };
