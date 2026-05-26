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
//  Fix 10 — applySlotAvailability: pushMenuToMeta() called after every slot
//            change so Meta catalog availability reflects current time slot.
//            Previously the slot scheduler updated is_available in the DB but
//            never told Meta, so customers saw all items as "in stock" in
//            WhatsApp regardless of the current serving slot.
//  Fix 11 — pushMenuToMeta: uses is_available AND is_stocked to determine
//            Meta availability. Previously only is_stocked was checked, so
//            slot-managed is_available changes never propagated to Meta.
//
//  Fix 12 — MENU UPLOAD BUG: Supabase JS v2 PostgrestBuilder is thenable but
//            does NOT expose .catch() as a standalone method. Chaining
//            .catch(() => {}) directly on a query builder throws:
//            "TypeError: supabaseAdmin.from(...).insert(...).catch is not a
//            function", which surfaced as the "Upload failed" error in the
//            manager portal. Fixed in three places:
//              • handleWhatsAppOrder audit_log insert
//              • POST /api/orders/:id/complete audit_log insert
//              • POST /api/menu/upload audit_log insert
//            All replaced with proper try { await ... } catch (_) {} wrappers.
//
//  Fix 13 — POST /api/menu/upload: Excel template uses column names 'title'
//            and 'image_link' but server was reading 'name' and 'image_url',
//            causing every row to fail the !item.name guard and be skipped
//            silently (0 upserted, N skipped). Also added mapTimeSlot() to
//            normalise 'Morning Tiffin', 'Dinner' etc. from custom_label_0
//            into the snake_case DB values the slot scheduler expects.
//  Fix 14 — POST /api/menu/upload: Excel 'id' column (M001, L001 etc.) is the
//            retailer_id (catalog SKU), NOT the UUID primary key. Upsert was
//            using onConflict:'restaurant_id,id' which tried to insert 'M001'
//            into the UUID id column — Supabase rejected every row with a type
//            error, causing 0 upserted / 29 skipped. Fixed by:
//              • mapping item.id → retailer_id in the inserted record
//              • switching onConflict to 'restaurant_id,retailer_id'
//              • logging per-row errors to Railway so skip reason is visible
//  Fix 15 — POST /api/menu/upload: no unique constraint exists on
//            (restaurant_id, retailer_id) in the Supabase menu_items table, so
//            .upsert() with any onConflict value throws:
//            "there is no unique or exclusion constraint matching the ON CONFLICT
//            specification". Fixed by replacing upsert with explicit
//            SELECT → UPDATE (if row exists) or INSERT (if new), keyed on
//            restaurant_id + retailer_id. No DB migration required.
//  Fix 16 — POST /api/menu/upload: full catalog sync strategy:
//            Phase 1 — parse & validate all rows, collect every retailer_id.
//            Phase 2 — single SELECT fetches all existing rows (avoids N SELECTs).
//            Phase 3 — INSERT or UPDATE each valid row (Fix 15 pattern).
//            Phase 4 — single bulk DELETE for retailer_ids absent from the
//                       spreadsheet (stale purge). Safety guard: aborts if
//                       0 valid rows parsed so an empty/corrupt upload never
//                       wipes the live catalog.
//            Phase 5 — re-apply time slot so new items go live immediately.
//            Phase 6 — audit log (purged count added).
//            Phase 7 — pushMenuToMeta so WhatsApp catalog reflects the upload.
//  Fix 19 — pushMenuToMeta + avail-toggle: Meta App source validator requires
//            brand and google_product_category fields — omitting them causes
//            "products have issues" in Commerce Manager. Added:
//              brand: 'Munafe'
//              google_product_category: '5765' (Food Items)
//            Also ensured description fallback is non-empty ('Freshly prepared')
//            as Meta rejects blank description on App-source products.
//  Fix 23 — GET /api/catalog/feed: deduplicate by retailer_id in the feed
//            response (first occurrence wins) so Meta doesn't reject the feed
//            for duplicate ids. Also added triggerMetaFeedRefetch() which calls
//            POST /{META_FEED_ID}/uploads to tell Meta to crawl the feed URL
//            immediately after an Excel upload instead of waiting up to 1 hour.
//            Requires META_FEED_ID env var (get from Commerce Manager feed URL).
//            Also added Phase 0 to POST /api/menu/upload: removes duplicate
//            retailer_id rows from Supabase (keeping the newest) before the
//            main sync loop, so the DB stays clean after every upload.
//  Fix 22 — GET /api/catalog/feed: serves a Meta-compatible CSV product feed
//            directly from the Supabase menu_items table. Point all Data file
//            sources in Meta Commerce Manager to this URL:
//              https://autom8-backend-production.up.railway.app/api/catalog/feed
//            Meta crawls it hourly and updates the WhatsApp catalog customers
//            see automatically. Columns: id, title, description, availability,
//            condition, price (e.g. "50.00 INR"), link, image_link, brand,
//            google_product_category (5765 = Food Items), custom_label_0 (slot).
//            No auth — Meta's crawler cannot send Bearer tokens.
//  Fix 21 — pushMenuToMeta disabled entirely: the batch API was updating the
//            Munafe App data source, which is NOT what powers the WhatsApp
//            catalog customers see. The customer-facing catalog is driven by
//            6 Data file (scheduled upload) sources. Every pushMenuToMeta call
//            created duplicate product entries in the App source with no
//            customer benefit, inflating the issue count (14→24→81→162→219+).
//            All 3 call sites (slot scheduler, menu upload, avail-toggle) are
//            commented out. The function is kept for when the correct feed
//            update mechanism is identified and re-enabled.
//  Fix 20 — pushMenuToMeta + avail-toggle: reverted method from 'CREATE' back
//            to 'UPDATE' (Fix 17 caused regressions). method:'CREATE' with
//            allow_upsert:true in the App-type data source creates a NEW product
//            record on every batch push instead of updating the existing one,
//            causing duplicate "issues" entries that accumulate (14→24→81→162).
//            'UPDATE' correctly patches existing records in-place and silently
//            skips any retailer_id not yet in the App source (no duplicates).
//            The brand/gpc/condition fields from Fix 19 are retained so products
//            that DO exist in the App source satisfy Meta's field validator.
//            Also added a 55-second in-process throttle guard (_metaPushLastRun
//            Map) so rapid-fire callers (slot scheduler + upload + avail-toggle
//            all within the same second) only result in one actual Meta API call
//            per restaurant per minute.
//  Fix 18 — POST /api/menu/upload: newly inserted rows defaulted to
//            is_available=null/false because the menuItem payload only set
//            is_available when isStocked===false. Fixed: always write
//            is_available=isStocked explicitly so INSERT rows are immediately
//            available (true) when stocked. applySlotAvailability in Phase 5
//            corrects slots right after, so items outside the current serving
//            window go back to false within the same request.
//  Fix 17 — pushMenuToMeta + avail-toggle: changed method from 'UPDATE' to
//            'CREATE' with allow_upsert:true. Meta's batch API with UPDATE
//            silently fails for products not yet in the App data source,
//            leaving them in "issues" state in Commerce Manager. CREATE +
//            allow_upsert is a true upsert: creates if absent, updates if
//            present. Also added condition:'new' which Meta requires for all
//            catalog products.
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

    const { data: availableItems, error: itemsError } = await supabaseAdmin
      .from('menu_items')
      .select('retailer_id, name')
      .eq('restaurant_id', restaurantId)
      .eq('is_stocked', true)
      .not('retailer_id', 'is', null)
      .order('name', { ascending: true })
      .limit(10);

    if (itemsError || !availableItems || availableItems.length === 0) {
      console.warn('[catalog-msg] No stocked items found for thumbnail (menu empty or all OOS)');
      return;
    }

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
        return;
      }

      const err = await response.json().catch(() => ({}));
      const errCode   = err?.error?.code;
      const errDetail = err?.error?.details ?? err?.error?.message ?? '';

      if (errCode === 131009 || errDetail.includes('not found')) {
        console.warn(`[catalog-msg] retailer_id=${item.retailer_id} not in Meta catalog — trying next`);
        continue;
      }

      console.error('[catalog-msg] API error (unexpected):', err);
      return;
    }

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

    // Fix 21: pushMenuToMeta disabled — batch API targets the wrong data source.
    // The WhatsApp catalog customers see is driven by the Data file feed URLs,
    // not the Munafe App source. Calling pushMenuToMeta was creating duplicate
    // product records in the App source (162→219 issues) with no customer impact.
    // pushMenuToMeta(restaurantId).catch(e =>
    //   console.error(`[slot] Meta push failed for ${restaurantId} (closed):`, e.message)
    // );

    return { available: 0, unavailable: 'all' };
  }

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

  const { error: e3 } = await supabaseAdmin
    .from('menu_items')
    .update({ is_available: false, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId)
    .eq('is_stocked', false)
    .in('time_slot', [slotDbValue, 'all']);
  if (e3) throw e3;

  console.log(`  ✅ Activated: ${activated?.length ?? 0} | Deactivated: ${deactivated?.length ?? 0}`);

  // Fix 21: pushMenuToMeta disabled — see comment above.
  // pushMenuToMeta(restaurantId).catch(e =>
  //   console.error(`[slot] Meta push failed for ${restaurantId} (slot=${slotDbValue}):`, e.message)
  // );

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
    const cutoff = new Date(Date.now() - 90 * 60 * 1000).toISOString();

    const { data: staleTokens } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('status', 'seated')
      .lt('seated_at', cutoff)
      .select('table_id');

    for (const token of staleTokens ?? []) {
      if (token.table_id) {
        await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', token.table_id);
        console.log(`[auto-release] Token freed table ${token.table_id} after 90 min`);
      }
    }

    const { data: staleOrders } = await supabaseAdmin
      .from('orders')
      .update({ status: 'completed' })
      .in('status', ['pending', 'confirmed', 'in_progress'])
      .lt('created_at', cutoff)
      .select('table_id, id, order_number');

    for (const order of staleOrders ?? []) {
      if (!order.table_id) continue;
      const { data: remaining } = await supabaseAdmin
        .from('orders')
        .select('id')
        .eq('table_id', order.table_id)
        .in('status', ['pending', 'confirmed', 'in_progress']);
      if (!remaining || remaining.length === 0) {
        await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', order.table_id);
        console.log(`[auto-release] Order ${order.order_number} freed table ${order.table_id} after 90 min`);
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
              price = hasRupeeSymbol ? numeric : numeric / 100;
            }
          } else if (typeof product.price === 'number') {
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
      query = query.order('is_stocked', { ascending: false });
    } else {
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
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });

    const { is_available } = req.body;
    const isStocked = Boolean(is_available);

    const { data, error } = await supabaseAdmin
      .from('menu_items')
      .update({
        is_stocked:   isStocked,
        is_available: isStocked,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id)
      .select()
      .single();

    if (error) throw error;

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
                // Fix 20: reverted to UPDATE — CREATE caused duplicate entries per push
                method:      'UPDATE',
                retailer_id: data.retailer_id,
                data: {
                  name:         data.name,
                  description:  data.description || 'Freshly prepared',
                  price:        Math.round((data.price || 0) * 100),
                  currency:     'INR',
                  availability: isStocked ? 'in stock' : 'out of stock',
                  image_url:    data.image_url || '',
                  url:          process.env.FRONTEND_URL || 'https://autom8.works/',
                  condition:    'new',
                  brand:                   'Munafe',
                  google_product_category: '5765',
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

    if (updateErr || !updated) {
      console.log(`[notifyOrderReady] Skipped for order ${orderId} — already ready or not found`);
      return;
    }

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
        const { data: kdsItem } = await supabaseAdmin
          .from('kds_items')
          .select('order_item:order_item_id!left(order_id), token_number, customer_phone, service_type')
          .eq('id', req.params.id)
          .single();

        const orderId = kdsItem?.order_item?.order_id;

        if (orderId) {
          const { data: allItems } = await supabaseAdmin
            .from('kds_items')
            .select('status, order_item:order_item_id!left(order_id)')
            .eq('restaurant_id', req.restaurant_id);

          const orderItems = (allItems ?? []).filter(i => i.order_item?.order_id === orderId);
          const allReady   = orderItems.length > 0 && orderItems.every(i => i.status === 'ready');

          if (allReady) {
            await notifyOrderReady({ orderId, restaurantId: req.restaurant_id, kdsItem });
          }
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
// Fix 13 — mapTimeSlot helper
// Normalises human-readable slot labels from the Excel template
// (e.g. 'Morning Tiffin', 'Dinner') into the snake_case DB values
// the slot scheduler expects.
// ============================================================================

function mapTimeSlot(raw) {
  if (!raw) return 'all';
  const SLOT_MAP = {
    'morning tiffin':  'morning_tiffin',
    'morning_tiffin':  'morning_tiffin',
    'lunch':           'lunch',
    'evening snacks':  'evening_snacks',
    'evening_snacks':  'evening_snacks',
    'dinner tiffin':   'dinner_tiffin',
    'dinner_tiffin':   'dinner_tiffin',
    'dinner':          'dinner_tiffin',
    'all':             'all',
  };
  return SLOT_MAP[String(raw).toLowerCase().trim()] || 'all';
}

// ============================================================================
// MENU UPLOAD ENDPOINT  (Fix 12 + Fix 13)
// ============================================================================

app.post('/api/menu/upload', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });

    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'items array is required and must not be empty' });

    let upserted = 0, skipped = 0, purged = 0;
    const errors = [];

    // ── Phase 0: Remove duplicate retailer_id rows already in DB ───────────────
    // If the same retailer_id exists multiple times in menu_items (from previous
    // buggy inserts), keep only the most recently updated row and delete the rest.
    // This prevents the feed from serving duplicate ids that Meta rejects.
    try {
      const { data: allRows } = await supabaseAdmin
        .from('menu_items')
        .select('id, retailer_id, updated_at')
        .eq('restaurant_id', req.restaurant_id)
        .not('retailer_id', 'is', null)
        .order('updated_at', { ascending: false });

      if (allRows) {
        const seen = new Map(); // retailer_id → first (newest) id
        const dupIds = [];
        for (const row of allRows) {
          if (seen.has(row.retailer_id)) {
            dupIds.push(row.id);  // older duplicate — mark for deletion
          } else {
            seen.set(row.retailer_id, row.id);
          }
        }
        if (dupIds.length > 0) {
          const { error: dupErr } = await supabaseAdmin
            .from('menu_items')
            .delete()
            .in('id', dupIds);
          if (dupErr) {
            console.warn('[menu/upload] Phase 0 dedup failed (non-fatal):', dupErr.message);
          } else {
            console.log(`[menu/upload] 🧹 Phase 0: removed ${dupIds.length} duplicate retailer_id row(s)`);
          }
        }
      }
    } catch (dedupErr) {
      console.warn('[menu/upload] Phase 0 dedup exception (non-fatal):', dedupErr.message);
    }

    // ── Phase 1: Parse & validate every row first ─────────────────────────────
    // Build the list of valid retailer_ids BEFORE touching the DB.
    // This is the safety gate: if the spreadsheet is malformed and yields 0
    // valid rows, we abort entirely rather than wiping the live catalog.
    const validRows   = [];   // fully-parsed, ready-to-write records
    const payloadIds  = [];   // all retailer_ids seen in the payload (valid or not)

    for (const item of items) {
      // Fix 13: Excel template uses 'title' not 'name' — accept both
      const itemName   = item.name || item.title;
      // Fix 14: Excel 'id' column (M001, L001…) is the catalog SKU / retailer_id,
      // NOT the Supabase UUID primary key.
      const retailerId = item.retailer_id || item.id;

      if (!retailerId || !itemName) {
        const msg = `Missing retailer_id/id or name/title (id=${item.id}, retailer_id=${item.retailer_id}, name=${item.name}, title=${item.title})`;
        console.warn(`[menu/upload] SKIP row: ${msg}`);
        errors.push({ row_id: retailerId || item.id, error: msg });
        skipped++;
        continue;
      }

      // Track every retailer_id in the payload (even if price is bad) so the
      // purge step never deletes a row that was intentionally included.
      payloadIds.push(String(retailerId).trim());

      const price = parseFloat(item.price) || 0;
      if (price <= 0) {
        const msg = `Invalid price: ${item.price}`;
        console.warn(`[menu/upload] SKIP ${retailerId}: ${msg}`);
        errors.push({ row_id: retailerId, error: msg });
        skipped++;
        continue;
      }

      let isStocked = true;
      if (item.is_available !== undefined && item.is_available !== null && item.is_available !== '') {
        const raw = String(item.is_available).toLowerCase().trim();
        isStocked = raw === 'true' || raw === '1' || raw === 'yes';
      }

      validRows.push({
        // DB record
        menuItem: {
          restaurant_id: req.restaurant_id,
          // Fix 14: retailer_id stores the catalog SKU (M001 etc.), never the UUID pk
          retailer_id:   String(retailerId).trim(),
          name:          String(itemName).trim(),
          description:   String(item.description || '').trim(),
          price,
          // Fix 13: Excel uses 'image_link'; also accept 'image_url'
          image_url:     (item.image_url || item.image_link)
                           ? String(item.image_url || item.image_link).trim()
                           : null,
          // Fix 13: Excel uses human-readable slot labels — normalise to snake_case
          time_slot:     mapTimeSlot(item.time_slot || item.custom_label_0),
          category:      item.category || 'General',
          is_stocked:    isStocked,
          // Fix 18: always write is_available explicitly so INSERT rows don't
          // default to null/false. isStocked=true → true here; applySlotAvailability
          // runs in Phase 5 immediately after and will correct to false for items
          // outside the current time slot. isStocked=false → always false.
          is_available:  isStocked,
          updated_at:    new Date().toISOString(),
        },
        retailerId: String(retailerId).trim(),
      });
    }

    // Safety guard: if zero rows survived validation, abort — do NOT purge.
    if (validRows.length === 0) {
      console.warn('[menu/upload] ABORT: 0 valid rows after parse — catalog unchanged');
      return res.status(400).json({
        error:   'No valid rows found in spreadsheet. Catalog unchanged.',
        skipped,
        errors,
      });
    }

    // ── Phase 2: SELECT existing retailer_ids for this restaurant ────────────
    // Single query — avoids N SELECT calls inside the write loop.
    const { data: existingRows, error: selectErr } = await supabaseAdmin
      .from('menu_items')
      .select('id, retailer_id')
      .eq('restaurant_id', req.restaurant_id);

    if (selectErr) {
      console.error('[menu/upload] Failed to fetch existing rows:', selectErr.message);
      return res.status(500).json({ error: selectErr.message });
    }

    const existingMap = new Map(
      (existingRows ?? []).map(r => [r.retailer_id, r.id])
    );

    // ── Phase 3: INSERT or UPDATE each valid row ──────────────────────────────
    // Fix 15: no unique constraint on (restaurant_id, retailer_id) in the DB,
    // so .upsert() with onConflict throws. Use explicit UPDATE or INSERT keyed
    // on the UUID pk retrieved in Phase 2.
    for (const { menuItem, retailerId } of validRows) {
      try {
        const existingId = existingMap.get(retailerId);
        let dbError;

        if (existingId) {
          // Row exists — UPDATE by its Supabase UUID primary key
          const { error } = await supabaseAdmin
            .from('menu_items')
            .update(menuItem)
            .eq('id', existingId);
          dbError = error;
        } else {
          // New SKU — INSERT (Supabase auto-generates UUID)
          const { error } = await supabaseAdmin
            .from('menu_items')
            .insert(menuItem);
          dbError = error;
        }

        if (dbError) {
          console.warn(`[menu/upload] SKIP ${retailerId}: db error — ${dbError.message}`);
          errors.push({ row_id: retailerId, error: dbError.message });
          skipped++;
          continue;
        }

        console.log(`[menu/upload] ✅ ${existingId ? 'updated' : 'inserted'} ${retailerId} — ${menuItem.name}`);
        upserted++;
      } catch (itemError) {
        console.warn(`[menu/upload] SKIP ${retailerId} (exception): ${itemError.message}`);
        errors.push({ row_id: retailerId, error: itemError.message });
        skipped++;
      }
    }

    // ── Phase 4: PURGE stale rows not present in the spreadsheet ─────────────
    // A single bulk DELETE for all retailer_ids that exist in the DB but are
    // absent from the payload. payloadIds includes every retailer_id seen in
    // the spreadsheet (even rows that failed price validation) so we never
    // accidentally delete an item the manager intended to keep.
    if (payloadIds.length > 0) {
      try {
        const { data: purgedRows, error: purgeErr } = await supabaseAdmin
          .from('menu_items')
          .delete()
          .eq('restaurant_id', req.restaurant_id)
          .not('retailer_id', 'in', `(${payloadIds.map(id => `"${id}"`).join(',')})`)
          .select('retailer_id, name');

        if (purgeErr) {
          console.warn('[menu/upload] Purge failed (non-fatal):', purgeErr.message);
        } else {
          purged = purgedRows?.length ?? 0;
          if (purged > 0) {
            console.log(`[menu/upload] 🗑️  Purged ${purged} stale item(s): ${(purgedRows ?? []).map(r => r.retailer_id).join(', ')}`);
          }
        }
      } catch (purgeEx) {
        console.warn('[menu/upload] Purge exception (non-fatal):', purgeEx.message);
      }
    }

    // ── Phase 5: Re-apply slot so new/updated items activate immediately ──────
    try {
      const currentSlot = getCurrentSlotIST();
      if (currentSlot) await applySlotAvailability(req.restaurant_id, currentSlot);
    } catch (slotErr) {
      console.warn('[menu/upload] Slot re-apply failed (non-fatal):', slotErr.message);
    }

    // ── Phase 6: Audit log ────────────────────────────────────────────────────
    // Fix 12: replaced .catch(() => {}) with try-catch — Supabase JS v2
    // PostgrestBuilder does not expose .catch() as a standalone method.
    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id:       req.user.sub,
        restaurant_id: req.restaurant_id,
        action:        'Menu items uploaded via Excel',
        details:       { upserted, skipped, purged, total: items.length, error_count: errors.length },
      });
    } catch (_) { /* audit log failure is non-fatal */ }

    const response = { success: true, upserted, skipped, purged, total: items.length };
    if (errors.length > 0) response.errors = errors;

    console.log(`[menu/upload] ✅ ${upserted} upserted, ${skipped} skipped, ${purged} purged for restaurant ${req.restaurant_id}`);

    // ── Phase 7: Trigger Meta to re-fetch the catalog feed immediately ──────────
    // The /api/catalog/feed endpoint serves the live Supabase data.
    // triggerMetaFeedRefetch() tells Meta to crawl it now rather than waiting
    // for the next hourly scheduled crawl.
    triggerMetaFeedRefetch().catch(err =>
      console.warn('[menu/upload] Meta feed trigger failed (non-fatal):', err.message)
    );

    res.json(response);

  } catch (err) {
    console.error('[menu/upload] Unexpected error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PUSH DB → META CATALOG (Fix 11)
// ============================================================================

// ── Meta feed re-fetch trigger (Fix 23) ─────────────────────────────────────
// After an Excel upload, call this to tell Meta to immediately re-crawl
// the /api/catalog/feed URL instead of waiting up to 1 hour.
// Uses the Meta Product Feed API: POST /{feed_id}/uploads
// META_FEED_ID must be set in Railway env vars (get it from Commerce Manager
// → Data sources → click your feed → the URL contains the feed ID).
async function triggerMetaFeedRefetch() {
  try {
    const META_ACCESS_TOKEN   = process.env.META_ACCESS_TOKEN;
    // META_DATA_SOURCE_ID: the numeric ID of your Data file source in Commerce Manager.
    // Find it in the URL when you click a Data source:
    //   .../data_sources/936316552566754?... → use 936316552566754
    // Can also be set as META_FEED_ID for backward compat.
    const META_DATA_SOURCE_ID = process.env.META_DATA_SOURCE_ID
                             || process.env.META_FEED_ID
                             || '936316552566754';   // default from known URL

    if (!META_ACCESS_TOKEN) {
      console.log('[meta-feed-trigger] Skipped — META_ACCESS_TOKEN not set');
      return;
    }

    // First get the feed id that belongs to this data source
    const feedsResp = await fetch(
      `https://graph.facebook.com/v20.0/${META_DATA_SOURCE_ID}/feeds?access_token=${META_ACCESS_TOKEN}`
    );
    const feedsData = await feedsResp.json();

    if (!feedsResp.ok || !feedsData.data?.length) {
      // Fall back: try triggering directly on the data source id
      console.log('[meta-feed-trigger] No feeds found via API, trying direct upload trigger...');
      const directResp = await fetch(
        `https://graph.facebook.com/v20.0/${META_DATA_SOURCE_ID}/uploads`,
        { method: 'POST', headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` } }
      );
      const directResult = await directResp.json();
      if (directResp.ok) {
        console.log(`[meta-feed-trigger] ✅ Direct trigger succeeded: ${JSON.stringify(directResult)}`);
      } else {
        console.warn('[meta-feed-trigger] Direct trigger failed:', JSON.stringify(directResult).slice(0, 200));
      }
      return;
    }

    const feedId = feedsData.data[0].id;
    console.log(`[meta-feed-trigger] Found feed id: ${feedId}`);

    const resp = await fetch(
      `https://graph.facebook.com/v20.0/${feedId}/uploads`,
      { method: 'POST', headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` } }
    );
    const result = await resp.json();
    if (resp.ok) {
      console.log(`[meta-feed-trigger] ✅ Meta feed re-fetch triggered: upload_id=${result.id}`);
    } else {
      console.warn('[meta-feed-trigger] Failed:', JSON.stringify(result).slice(0, 200));
    }
  } catch (err) {
    console.warn('[meta-feed-trigger] Non-fatal error:', err.message);
  }
}

// Throttle guard: at most one Meta push per restaurant per 60 seconds.
// Prevents the slot scheduler (fires every 60s) + upload + avail-toggle from
// all hammering the Meta batch API simultaneously and creating duplicates.
const _metaPushLastRun = new Map(); // restaurantId → timestamp ms

async function pushMenuToMeta(restaurantId) {
  const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
  const META_CATALOG_ID   = process.env.META_CATALOG_ID;
  if (!META_ACCESS_TOKEN || !META_CATALOG_ID) {
    console.warn('[meta-push] Skipped — META_ACCESS_TOKEN or META_CATALOG_ID not set');
    return { success: false };
  }

  // Throttle: skip if last push for this restaurant was < 55 seconds ago
  const lastRun = _metaPushLastRun.get(restaurantId) || 0;
  const elapsed = Date.now() - lastRun;
  if (elapsed < 55_000) {
    console.log(`[meta-push] Throttled for ${restaurantId} — last push ${Math.round(elapsed/1000)}s ago, skipping`);
    return { success: true, skipped: true };
  }
  _metaPushLastRun.set(restaurantId, Date.now());

  const { data: items, error } = await supabaseAdmin
    .from('menu_items')
    .select('name, description, price, image_url, retailer_id, is_stocked, is_available')
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

    // Fix 17 reverted (Fix 20): method:'CREATE' with allow_upsert:true created
    // duplicate product entries in the Munafe App source on every push, causing
    // the issue count to accumulate (14→24→81). Reverted to method:'UPDATE'
    // which correctly updates existing products in-place. Products that genuinely
    // don't exist in the App source will be silently skipped (not duplicated).
    // brand + google_product_category + condition fields are kept from Fix 19
    // to satisfy Meta's App source field validator for products that do exist.
    const requests = batch.map(item => ({
      method:      'UPDATE',
      retailer_id: item.retailer_id,
      data: {
        name:         item.name,
        description:  item.description || 'Freshly prepared',
        price:        Math.round((item.price || 0) * 100),
        currency:     'INR',
        availability: (item.is_available && item.is_stocked) ? 'in stock' : 'out of stock',
        image_url:    item.image_url || '',
        url:          process.env.FRONTEND_URL || 'https://autom8.works/',
        condition:    'new',
        // Fix 19: brand + google_product_category required by Meta App source
        // validator — omitting them causes "products have issues" in Commerce Manager.
        // 5765 = Food Items (Food, Beverages & Tobacco > Food Items)
        brand:                   'Munafe',
        google_product_category: '5765',
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
// ============================================================================

app.post('/api/orders/:id/complete', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const orderId = req.params.id;

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

    const firstKdsItem = orderKdsItems.find(i => i.customer_phone) ?? orderKdsItems[0];
    await notifyOrderReady({
      orderId,
      restaurantId: req.restaurant_id,
      kdsItem: firstKdsItem,
    });

    // Fix 12: replaced .catch(() => {}) with try-catch (Supabase v2 compatibility)
    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id:       req.user.sub,
        restaurant_id: req.restaurant_id,
        action:        'Order marked ready via /complete',
        details: {
          order_id:          orderId,
          order_number:      order.order_number,
          kds_items_updated: alreadyAllDone ? 0 : activeItems.length,
        },
      });
    } catch (_) { /* audit log failure is non-fatal */ }

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

    const combo        = token.meta?.combo ?? [];
    const tableNumbers = combo.map(t => String(t[0]));
    const tableLines   = combo.length > 0
      ? combo.map(t => `Table ${t[0]} (${t[2]} seats)`).join(', ')
      : 'multiple tables';

    let tableIds = [];
    if (tableNumbers.length > 0) {
      const { data: tableRows } = await supabaseAdmin
        .from('tables')
        .select('id, table_number')
        .eq('restaurant_id', req.restaurant_id)
        .in('table_number', tableNumbers);
      tableIds = (tableRows ?? []).map(t => t.id);
    }

    const primaryTableId     = tableIds[0] ?? null;
    const primaryTableNumber = tableNumbers[0] ?? null;

    const { data: updatedToken, error: updateError } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({
        status:       'seated',
        table_id:     primaryTableId,
        table_number: primaryTableNumber,
        seated_at:    new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (updateError) throw updateError;

    if (tableIds.length > 0) {
      await supabaseAdmin
        .from('tables')
        .update({ status: 'occupied' })
        .in('id', tableIds)
        .eq('restaurant_id', req.restaurant_id);
      console.log(`[approve] Marked ${tableIds.length} table(s) occupied: ${tableNumbers.join(', ')}`);
    }

    if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
      await sendWhatsAppMessage(token.phone,
        `✅ *Great news! Your table arrangement has been confirmed.*\n\n` +
        `Token: *${token.id}*\n` +
        `Party of: *${token.pax} people*\n` +
        `Tables: *${tableLines}*\n\n` +
        `Please head to the restaurant — our staff will seat your party shortly. 🍽️`
      );
      console.log(`[approve] Sending catalog to ${token.phone}`);
      await sendWhatsAppCatalogMessage(token.phone, req.restaurant_id);
    }

    broadcastToRestaurant(req.restaurant_id, {
      type: 'TOKEN_APPROVED', token: updatedToken, timestamp: new Date().toISOString(),
    });

    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id: req.user.sub, restaurant_id: req.restaurant_id,
        action: 'Large party token approved',
        details: { token_id: req.params.id, pax: token.pax, combo, tables_occupied: tableNumbers },
      });
    } catch (_) { /* non-fatal */ }

    console.log(`[approve] ✅ Token ${token.id} approved — ${token.pax} guests seated across ${tableNumbers.join(', ')}`);
    res.json({ success: true, token: updatedToken });
  } catch (err) {
    console.error('[PUT /api/tokens/:id/approve]', err);
    res.status(500).json({ error: err.message || 'Failed to approve token' });
  }
});

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
    } catch (_) { /* non-fatal */ }
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
          // Fix 12: replaced .catch(() => {}) with try-catch (Supabase v2 compatibility)
          try {
            await supabaseAdmin.from('audit_logs').insert({
              action: 'WhatsApp message received',
              details: {
                type: message.type, from: message.from,
                phone_number_id: metadata?.phone_number_id, message_id: message.id,
              },
            });
          } catch (_) { /* non-fatal */ }
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

  if (message.type === 'text') {
    let restaurantId = process.env.DEFAULT_RESTAURANT_ID || null;
    if (metadata?.phone_number_id) {
      const { data: restaurant } = await supabaseAdmin.from('restaurants').select('id')
        .eq('whatsapp_phone_number_id', metadata.phone_number_id).eq('is_active', true).single();
      if (restaurant) restaurantId = restaurant.id;
    }
    const wasFeedback = await handleFeedbackReply(customerPhone, message.text?.body || '', restaurantId);
    if (wasFeedback) return;
  }
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
  const skippedOos  = [];
  for (const item of productItems) {
    const { data: menuItem } = await supabaseAdmin.from('menu_items').select('id, name, price, is_stocked, is_available')
      .eq('restaurant_id', restaurantId).eq('retailer_id', item.product_retailer_id).maybeSingle();
    if (!menuItem) { console.warn(`[WA Order] ⚠️ No menu item for retailer_id: ${item.product_retailer_id}`); continue; }
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
  // Fix 12: replaced .catch(() => {}) with try-catch (Supabase v2 compatibility)
  try {
    await supabaseAdmin.from('audit_logs').insert({
      restaurant_id: restaurantId, action: 'WhatsApp order created',
      details: { order_id: orderData.id, order_number: orderNumber, phone: normalizedPhone, item_count: kdsInserts.length },
    });
  } catch (_) { /* non-fatal */ }
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
// INTERNAL MENU ITEMS ENDPOINT (used by munafe chat bot)
// ============================================================================

app.get('/api/internal/menu-items', async (req, res) => {
  try {
    const secret   = req.headers['x-internal-secret'];
    const expected = process.env.AUTOM8_KDS_SECRET || 'munafe_kds_sync_2026';
    if (secret !== expected)
      return res.status(403).json({ error: 'Forbidden' });

    const restaurantId = req.query.restaurant_id;
    if (!restaurantId)
      return res.status(400).json({ error: 'restaurant_id query param required' });

    const { data, error } = await supabaseAdmin
      .from('menu_items')
      .select('id, name, description, price, image_url, time_slot, retailer_id, is_available, is_stocked, category')
      .eq('restaurant_id', restaurantId)
      .order('time_slot', { ascending: true })
      .order('name',      { ascending: true });

    if (error) throw error;

    res.json({ success: true, count: data.length, items: data });
  } catch (err) {
    console.error('[GET /api/internal/menu-items]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// FEEDBACK SYSTEM
// ============================================================================

app.post('/api/feedback/queue', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { customer_phone, customer_name, token_number, table_number } = req.body;
    if (!customer_phone) return res.status(400).json({ error: 'customer_phone required' });

    const { error } = await supabaseAdmin
      .from('feedback_pending')
      .insert({
        restaurant_id:  req.restaurant_id,
        customer_phone: String(customer_phone).replace(/\D/g, ''),
        customer_name:  customer_name || 'Guest',
        token_number:   token_number || null,
        table_number:   table_number || null,
        freed_at:       new Date().toISOString(),
      });

    if (error) throw error;
    console.log(`[feedback-queue] ✅ Queued for ${customer_phone}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[feedback-queue]', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function handleFeedbackReply(customerPhone, message, restaurantId) {
  try {
    const phone = String(customerPhone).replace(/\D/g, '');

    const { data: record } = await supabaseAdmin
      .from('feedback_pending')
      .select('*')
      .eq('customer_phone', phone)
      .eq('restaurant_id', restaurantId)
      .eq('manager_notified', false)
      .not('feedback_sent', 'eq', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!record) return false;

    const text = message.trim();

    const starMatch = text.match(/[1-5⭐★]/);
    const rating    = starMatch
      ? (parseInt(starMatch[0]) || (starMatch[0].match(/[⭐★]/g) || []).length || null)
      : null;

    await supabaseAdmin
      .from('feedback_pending')
      .update({
        feedback_text:        text,
        feedback_rating:      rating,
        feedback_received_at: new Date().toISOString(),
        manager_notified:     true,
      })
      .eq('id', record.id);

    const thankMsg = rating && rating >= 4
      ? `🙏 Thank you for the *${rating}⭐* rating, ${record.customer_name}!\n\nWe're so glad you enjoyed your visit. See you again soon! 😊`
      : `🙏 Thank you for your feedback, ${record.customer_name}!\n\nWe appreciate your input and will use it to improve. Hope to see you again! 😊`;

    await sendWhatsAppMessage(customerPhone, thankMsg);

    const ratingLine = rating ? `Rating: ${'⭐'.repeat(rating)} (${rating}/5)\n` : '';
    await sendWhatsAppMessage(
      process.env.MANAGER_WHATSAPP_NUMBER,
      `📣 *Customer Feedback*\n` +
      `────────────────────\n` +
      `Customer: ${record.customer_name}\n` +
      `Phone: +${phone}\n` +
      `Token: ${record.token_number || '—'}\n` +
      `Table: ${record.table_number || '—'}\n` +
      `${ratingLine}` +
      `Feedback: ${text}\n` +
      `────────────────────`
    );

    console.log(`[feedback] ✅ Received from ${phone} — rating: ${rating}`);
    return true;
  } catch (err) {
    console.error('[feedback-reply]', err.message);
    return false;
  }
}

function startFeedbackScheduler() {
  setInterval(async () => {
    try {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      const { data: pending } = await supabaseAdmin
        .from('feedback_pending')
        .select('*')
        .eq('feedback_sent', false)
        .lte('freed_at', twoHoursAgo)
        .limit(20);

      for (const record of pending ?? []) {
        try {
          await sendWhatsAppMessage(
            record.customer_phone,
            `Hi ${record.customer_name}! 😊\n\n` +
            `Thank you for dining with us today` +
            `${record.table_number ? ` (Table ${record.table_number})` : ''}.\n\n` +
            `*How was your experience?* We'd love your feedback!\n\n` +
            `⭐ Reply with a rating from *1 to 5*:\n` +
            `5 ⭐ — Excellent\n` +
            `4 ⭐ — Good\n` +
            `3 ⭐ — Average\n` +
            `2 ⭐ — Below average\n` +
            `1 ⭐ — Poor\n\n` +
            `You can also share any comments along with your rating. 🙏`
          );

          await supabaseAdmin
            .from('feedback_pending')
            .update({
              feedback_sent:    true,
              feedback_sent_at: new Date().toISOString(),
            })
            .eq('id', record.id);

          console.log(`[feedback-sender] ✅ Sent to ${record.customer_phone} for token ${record.token_number}`);

        } catch (innerErr) {
          console.error(`[feedback-sender] Failed for ${record.customer_phone}:`, innerErr.message);
        }
      }
    } catch (err) {
      console.error('[feedback-sender] Scan error:', err.message);
    }
  }, 10 * 60 * 1000);

  console.log('📣 Feedback scheduler started — sends 2 hours after table freed');
}

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
// META CATALOG FEED ENDPOINT  (Fix 22)
// Serves a Meta-compatible CSV product feed from the Supabase menu_items table.
// Point all Data file sources in Meta Commerce Manager to:
//   https://autom8-backend-production.up.railway.app/api/catalog/feed?restaurant_id=<id>
// Meta will crawl this URL on its scheduled interval (hourly) and update the
// WhatsApp catalog customers see automatically.
// No auth required — Meta's crawler has no way to send a Bearer token.
// ============================================================================

app.get('/api/catalog/feed', async (req, res) => {
  try {
    const restaurantId = req.query.restaurant_id
      || process.env.DEFAULT_RESTAURANT_ID
      || '46fb9b9e-431a-43c9-9edb-d316b0fef216';

    const { data: rawItems, error } = await supabaseAdmin
      .from('menu_items')
      .select('retailer_id, name, description, price, image_url, time_slot, is_stocked, is_available, category')
      .eq('restaurant_id', restaurantId)
      .not('retailer_id', 'is', null)
      .order('time_slot', { ascending: true })
      .order('name',      { ascending: true });

    if (error) throw error;
    if (!rawItems || rawItems.length === 0) {
      return res.status(404).json({ error: 'No menu items found for this restaurant' });
    }

    // Deduplicate by retailer_id — keep the first occurrence (Fix 23).
    // Duplicates can exist in the DB when the same SKU was inserted twice
    // before the unique-constraint-free upsert logic was in place.
    const seen = new Set();
    const items = rawItems.filter(item => {
      if (seen.has(item.retailer_id)) {
        console.warn(`[catalog-feed] Duplicate retailer_id ${item.retailer_id} skipped`);
        return false;
      }
      seen.add(item.retailer_id);
      return true;
    });

    const baseUrl = process.env.FRONTEND_URL || 'https://autom8.works/';

    // Meta CSV feed format — required columns:
    // id, title, description, availability, condition, price, link, image_link,
    // brand, google_product_category
    const csvHeader = [
      'id',
      'title',
      'description',
      'availability',
      'condition',
      'price',
      'link',
      'image_link',
      'brand',
      'google_product_category',
      'custom_label_0',
    ].join(',');

    const escCsv = (val) => {
      const s = String(val || '').replace(/"/g, '""');
      return /[,"\n\r]/.test(s) ? `"${s}"` : s;
    };

    const rows = items.map(item => {
      // Meta availability: must be exactly "in stock" or "out of stock"
      const availability = (item.is_available && item.is_stocked)
        ? 'in stock'
        : 'out of stock';

      // Price format for CSV feed: "50.00 INR" (amount + space + currency)
      const priceFormatted = `${(item.price || 0).toFixed(2)} INR`;

      // Use image_url if present, otherwise a placeholder that won't break Meta
      const imageUrl = item.image_url || '';

      // custom_label_0 = time slot (human-readable for Meta's custom label)
      const slotLabel = {
        morning_tiffin: 'Morning Tiffin',
        lunch:          'Lunch',
        evening_snacks: 'Evening Snacks',
        dinner_tiffin:  'Dinner Tiffin',
        all:            'All Day',
      }[item.time_slot] || 'All Day';

      return [
        escCsv(item.retailer_id),
        escCsv(item.name),
        escCsv(item.description || 'Freshly prepared'),
        escCsv(availability),
        'new',
        escCsv(priceFormatted),
        escCsv(baseUrl),
        escCsv(imageUrl),
        'Munafe',
        '5765',   // Food Items (Food, Beverages & Tobacco > Food Items)
        escCsv(slotLabel),
      ].join(',');
    });

    const csv = [csvHeader, ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="catalog_feed.csv"');
    // Allow Meta's crawler to cache for up to 1 hour
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(csv);

    console.log(`[catalog-feed] ✅ Served ${items.length} items for restaurant ${restaurantId}`);

  } catch (err) {
    console.error('[catalog-feed] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/catalog/feed/template ──────────────────────────────────────────
// Returns the current live catalog as a manager-friendly .xlsx download.
// The "Download template" button in the Manager Portal calls this endpoint
// so the manager always starts from the actual live data, not dummy rows.
// No auth required — the file contains no sensitive data.
app.get('/api/catalog/feed/template', async (req, res) => {
  try {
    const restaurantId = req.query.restaurant_id
      || process.env.DEFAULT_RESTAURANT_ID
      || '46fb9b9e-431a-43c9-9edb-d316b0fef216';

    const { data: rawItems, error } = await supabaseAdmin
      .from('menu_items')
      .select('retailer_id, name, description, price, image_url, time_slot, is_stocked, is_available')
      .eq('restaurant_id', restaurantId)
      .not('retailer_id', 'is', null)
      .order('time_slot', { ascending: true })
      .order('name',      { ascending: true });

    if (error) throw error;
    if (!rawItems || rawItems.length === 0)
      return res.status(404).json({ error: 'No menu items found' });

    // Deduplicate by retailer_id — same logic as the CSV feed
    const seen  = new Set();
    const items = rawItems.filter(item => {
      if (seen.has(item.retailer_id)) return false;
      seen.add(item.retailer_id);
      return true;
    });

    // Build CSV-style data that the frontend SheetJS will receive as JSON
    // Columns match exactly what mapExcelRowToMenuItem() in ManagerPortal.jsx expects:
    //   id, title, description, price (number), custom_label_0, image_link, is_available
    const SLOT_LABEL = {
      morning_tiffin: 'Morning Tiffin',
      lunch:          'Lunch',
      evening_snacks: 'Evening Snacks',
      dinner_tiffin:  'Dinner Tiffin',
      all:            'All Day',
    };

    const rows = items.map(item => ({
      id:            item.retailer_id,
      title:         item.name        || '',
      description:   item.description || '',
      price:         Number(item.price) || 0,
      custom_label_0: SLOT_LABEL[item.time_slot] || 'All Day',
      image_link:    item.image_url   || '',
      is_available:  (item.is_stocked !== false && item.is_available !== false) ? 'TRUE' : 'FALSE',
    }));

    res.json({ success: true, items: rows, total: rows.length });
    console.log(`[catalog-template] ✅ Served ${rows.length} items for restaurant ${restaurantId}`);
  } catch (err) {
    console.error('[catalog-template] Error:', err.message);
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
//SERVEREOF
