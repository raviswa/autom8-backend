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
// MENU ITEMS ENDPOINTS
// ============================================================================


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

    // Release the table if no other active orders on it
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

// Get KDS feed
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

// Update KDS item status
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

// Get all tables
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

// Update table status
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

// Create payment
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

// Get daily sales report
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
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

module.exports = { app, wss, broadcastToRestaurant };
// ============================================================================
// AUTOM8 - META CATALOG SYNC
// Add this to your existing server.js
// ============================================================================

// ============================================================================
// CATALOG SYNC - CONFIGURATION
// Add these to your Railway backend environment variables:
//
// META_ACCESS_TOKEN=EAAxxxxxxx
// META_CATALOG_ID=1234567890123
// META_WEBHOOK_VERIFY_TOKEN=autom8-webhook-secret  (make up any string)
// ============================================================================

// ============================================================================
// 1. SYNC FUNCTION - Pulls catalog from Meta and updates Supabase
// ============================================================================

async function syncCatalogFromMeta(restaurantId) {
  const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
  const META_CATALOG_ID = process.env.META_CATALOG_ID;
  console.log('META_ACCESS_TOKEN set:', !!process.env.META_ACCESS_TOKEN);
  console.log('META_CATALOG_ID set:', !!process.env.META_CATALOG_ID);

  if (!META_ACCESS_TOKEN || !META_CATALOG_ID) {
    console.error('Missing META_ACCESS_TOKEN or META_CATALOG_ID');
    return { success: false, error: 'Missing Meta credentials' };
  }

  try {
    console.log('🔄 Starting Meta catalog sync...');

    // Fetch all products from Meta Catalog
    let allProducts = [];
    let nextUrl = `https://graph.facebook.com/v18.0/${META_CATALOG_ID}/products?fields=id,name,description,price,currency,image_url,availability,category,retailer_id&limit=100&access_token=${META_ACCESS_TOKEN}`;

    // Handle pagination - Meta returns max 100 items per page
    while (nextUrl) {
      const response = await fetch(nextUrl);
      const data = await response.json();

      if (data.error) {
        throw new Error(data.error.message);
      }

      allProducts = [...allProducts, ...(data.data || [])];
      nextUrl = data.paging?.next || null;
    }

    console.log(`📦 Fetched ${allProducts.length} products from Meta`);

    // Process each product and upsert into Supabase
    let synced = 0;
    let errors = 0;

    for (const product of allProducts) {
      try {
        // Parse price (Meta sends as "10.99 USD" or in cents)
        let price = 0;
        if (product.price) {
          // Meta format: "1099" (in cents) or "10.99"
          price = typeof product.price === 'string'
            ? parseFloat(product.price.replace(/[^0-9.]/g, '')) 
            : product.price / 100;
        }

        const menuItem = {
          restaurant_id: restaurantId,
          name: product.name,
          description: product.description || '',
          price: price,
          image_url: product.image_url || null,
          category: product.category || 'General',
          is_available: product.availability === 'in stock',
          meta_product_id: product.id,
          retailer_id: product.retailer_id || product.id,
          updated_at: new Date().toISOString()
        };

        // Upsert: insert if new, update if exists (match by meta_product_id)
        const { error } = await supabaseAdmin
          .from('menu_items')
          .upsert(menuItem, {
            onConflict: 'restaurant_id,meta_product_id',
            ignoreDuplicates: false
          });

        if (error) {
          console.error(`Error upserting ${product.name}:`, error);
          errors++;
        } else {
          synced++;
        }
      } catch (itemError) {
        console.error(`Error processing product ${product.id}:`, itemError);
        errors++;
      }
    }

    console.log(`✅ Sync complete: ${synced} synced, ${errors} errors`);

    return {
      success: true,
      total: allProducts.length,
      synced,
      errors,
      timestamp: new Date().toISOString()
    };

  } catch (err) {
    console.error('Catalog sync failed:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================================
// 2. API ENDPOINTS
// ============================================================================

// Manual sync trigger (Owner can click "Sync Now" button)
app.post('/api/catalog/sync', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    // Only owner can trigger manual sync
    if (req.user_role !== 'owner' && req.user_role !== 'manager') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const result = await syncCatalogFromMeta(req.restaurant_id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get sync status / last sync time
app.get('/api/catalog/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('menu_items')
      .select('updated_at')
      .eq('restaurant_id', req.restaurant_id)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (error) throw error;

    res.json({
      success: true,
      lastSync: data?.[0]?.updated_at || null,
      itemCount: data?.length || 0
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get all menu items for portal
app.get('/api/menu-items', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { category, available_only } = req.query;

    let query = supabaseAdmin
      .from('menu_items')
      .select('*')
      .eq('restaurant_id', req.restaurant_id)
      .order('category', { ascending: true })
      .order('name', { ascending: true });

    if (category) {
      query = query.eq('category', category);
    }

    if (available_only === 'true') {
      query = query.eq('is_available', true);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, items: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Toggle item availability (Owner only)
app.put('/api/menu-items/:id/availability', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner') {
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
// 3. META WEBHOOK - Real-time updates when catalog changes
// ============================================================================

// Webhook verification (Meta sends GET to verify)
app.get('/api/catalog/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified');
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Forbidden' });
  }
});

// Webhook receiver (Meta sends POST when catalog changes)
app.post('/api/catalog/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('📨 Meta webhook received:', JSON.stringify(body, null, 2));

    // Acknowledge receipt immediately (Meta requires fast response)
    res.status(200).send('EVENT_RECEIVED');

    // Process the catalog update in background
    if (body.object === 'product_catalog') {
      // Get all restaurants (or specific one from webhook data)
      const { data: restaurants } = await supabaseAdmin
        .from('restaurants')
        .select('id');

      // Sync catalog for each restaurant
      for (const restaurant of restaurants || []) {
        await syncCatalogFromMeta(restaurant.id);
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(200).send('EVENT_RECEIVED'); // Always return 200 to Meta
  }
});

// ============================================================================
// 4. SCHEDULED AUTO-SYNC (every 5 minutes as fallback)
// ============================================================================

function startScheduledSync() {
  const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes

  setInterval(async () => {
    console.log('⏰ Running scheduled catalog sync...');

    try {
      const { data: restaurants } = await supabaseAdmin
        .from('restaurants')
        .select('id')
        .eq('is_active', true); // Only sync active restaurants (add this column if needed)

      for (const restaurant of restaurants || []) {
        await syncCatalogFromMeta(restaurant.id);
      }
    } catch (err) {
      console.error('Scheduled sync error:', err);
    }
  }, SYNC_INTERVAL);

  console.log('⏰ Scheduled catalog sync started (every 5 minutes)');
}

// Start scheduled sync when server starts
startScheduledSync();

// ============================================================================
// SUPABASE SCHEMA UPDATE - Run this SQL in Supabase SQL Editor
// ============================================================================
/*
-- Add meta_product_id column to menu_items table
ALTER TABLE public.menu_items
ADD COLUMN IF NOT EXISTS meta_product_id TEXT,
ADD COLUMN IF NOT EXISTS retailer_id TEXT;

-- Add unique constraint for upsert to work
ALTER TABLE public.menu_items
ADD CONSTRAINT unique_restaurant_meta_product
UNIQUE (restaurant_id, meta_product_id);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_menu_items_meta_product_id
ON public.menu_items(meta_product_id);
*/
