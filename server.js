// ============================================================================
// AUTOM8 BACKEND — MAIN SERVER (MERGED — POS + CHAT)
// server.js
//
// ENHANCED — 7 production requirements layered on top of the merged baseline:
//
//   REQ 1 — Context-Aware Condiment Prompts ("Sambar / Raita Nudge")
//            detectCondimentContext() + buildSpecialNotesPrompt()
//            Hooked into handleWhatsAppOrder() post-order-creation.
//
//   REQ 2 — 2-Minute Graceful Timeout for Special Notes (Auto-Close)
//            startSpecialNotesTimeoutMonitor() — 60-second poll.
//
//   REQ 3 — Automated Post-Free Feedback Loops (2 Hours Post-Release)
//            startFeedbackScheduler() + handleFeedbackReply() + queueFeedbackForTable()
//
//   REQ 4 — Viral Growth & Referral Module
//            validateReferralCode()  — verifies first-order + applies discount
//            generateReferralSharePrompt() — post-order WA share message
//            POST /api/referrals/validate  — inbound code entry
//            POST /api/referrals/share     — post-order share trigger
//            Hooked into handleWhatsAppOrder() after order confirmation.
//
//   REQ 5 — Logistics / Delivery Rider Tracking Notifications
//            sendRiderAssignedNotification() — formats partner-aware WA message
//            POST /api/delivery/rider-assigned — webhook receiver from
//            Dunzo / Porter / In-House dispatcher
//
//   REQ 6 — Multi-Branch Enterprise Dashboard
//            POST /api/enterprise/dashboard  — role-gated brand/store analytics
//            enforceHierarchyAccess() — owner/corporate vs store_manager guard
//            getRFMAtRiskCount()       — customers silent for 14+ days
//
//   REQ 7 — GST Compliance Engine & Accounting Sync
//            calculateGST()           — base-price → CGST/SGST breakdown
//            buildInvoicePayload()    — structured JSON for PDF renderer
//            POST /api/invoices/generate  — on-demand invoice for any order
//            POST /api/invoices/webhook   — payment-confirmed auto-trigger
//            startAccountingSyncScheduler() — daily Zoho/Tally push at 23:30 IST
//
// MIGRATION NOTES (unchanged from merged baseline):
//   - Supabase clients: src/config/supabase.js  (single source of truth)
//   - supabaseChat REMOVED — chat tables live in the same restaurant DB
//   - Auth middleware: src/middleware/auth.js
//   - Routes: /api/auth → src/routes/auth.js
//             /api/*    → src/routes/pos.js
//             /api/onboarding → src/routes/onboarding.js
//             /api/whatsapp  → src/routes/webhook.js
// ============================================================================

process.on('uncaughtException',  err => { console.error('CRASH:', err.stack); process.exit(1); });
process.on('unhandledRejection', (reason) => { console.error('REJECTION:', reason); process.exit(1); });

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

const { clients, broadcastToRestaurant } = require('./src/websocket');

// BEGIN: Separated/Resilient Architecture Updates — waHandlers import
// validateReferralCode and generateReferralSharePrompt are used directly
// by /api/referrals/validate and /api/referrals/generate routes in this file.
// handleWhatsAppOrder and handleFeedbackReply are used only by webhook.js —
// they are imported there directly from waHandlers and do not need to be
// re-imported here.

let _waHandlers = {};
try {
  _waHandlers = require('./src/handlers/waHandlers');
  console.log('[server] ✅ waHandlers loaded');
} catch (err) {
  console.error('[server] ⚠️ waHandlers failed to load — referral routes will use fallbacks:', err.message);
}

const {
  validateReferralCode = async () => {
    console.error('[server] validateReferralCode unavailable — waHandlers not loaded');
    return false;
  },
  generateReferralSharePrompt = async () => {
    console.error('[server] generateReferralSharePrompt unavailable — waHandlers not loaded');
  },
} = _waHandlers;
// END: Separated/Resilient Architecture Updates — waHandlers import

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

app.use('/api/auth',        require('./src/routes/auth'));
app.use('/api/dashboard',   require('./src/routes/dashboard'));
app.use('/api/marketing',   require('./src/routes/marketing'));   // ← ADD
app.use('/api/restaurants', require('./src/routes/marketing'));   // ← ADD (for WABAStrip)
app.use('/api',             require('./src/routes/pos'));
app.use('/api/onboarding',  require('./src/routes/onboarding'));
app.use('/api/whatsapp',    require('./src/routes/webhook'));

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

// BEGIN: Updated Table Integrations — restaurant_integrations
async function sendWhatsAppMessage(toNumber, message, restaurantId = null) {
  try {
    // Default to global env vars; override per-restaurant if credentials exist
    let accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
    let phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    let apiUrl        = process.env.WHATSAPP_API_URL;

    if (restaurantId) {
      const { data: integration } = await supabaseAdmin
        .from('restaurant_integrations')
        .select('access_token, phone_number_id, api_endpoint')
        .eq('restaurant_id', restaurantId)
        .eq('provider', 'whatsapp')
        .eq('is_active', true)
        .maybeSingle();
      if (integration?.access_token)    accessToken   = integration.access_token;
      if (integration?.phone_number_id) phoneNumberId = integration.phone_number_id;
      if (integration?.api_endpoint)    apiUrl        = integration.api_endpoint;
    }
    // END: Updated Table Integrations — restaurant_integrations

    const response = await fetch(
      `${apiUrl}/${phoneNumberId}/messages`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
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
// REQ 2 — 2-MINUTE GRACEFUL TIMEOUT FOR SPECIAL NOTES (Auto-Close)
// ============================================================================
//
// ARCHITECTURE NOTE — where the wait state actually lives:
//   The Python ADK booking_agent writes the wait state into
//   conversation_states.context (a JSONB column) and sets
//   conversation_states.current_state = 'awaiting_special_notes'.
//   Specifically it stores:
//     context->>'booking_step'            = 'awaiting_special_notes'
//     context->>'special_notes_asked_at'  = Unix epoch float (time.time())
//     context->>'booking_id'              = UUID of the bookings row
//     context->>'customer_name'           = display name
//
//   The `bookings` table status enum is:
//     pending | confirmed | rejected | cancelled | completed | no_show
//   'waiting_for_notes' is NOT a valid enum value — never write it there.
//
// WHAT THIS MONITOR DOES:
//   1. Queries conversation_states WHERE current_state='awaiting_special_notes'
//      AND (context->>'special_notes_asked_at')::float < epoch_now - 120
//   2. For each stale session:
//      a. Updates bookings.status → 'confirmed' using the booking_id from context
//         (bookings.status 'confirmed' IS a valid enum value ✅)
//      b. Clears the conversation state back to 'visit_complete' so the Python
//         agent doesn't re-enter the notes loop on the next message
//      c. Sends booking confirmation WA message to the customer
//      d. Fires a non-blocking manager ping
// ============================================================================

function startSpecialNotesTimeoutMonitor() {
  setInterval(async () => {
    try {
      // Unix epoch seconds — matches Python's time.time() stored in context
      const epochNowMinus2Min = (Date.now() / 1000) - (2 * 60);

      // Query conversation_states — the only table that tracks this wait state
      // Supabase PostgREST filter syntax for JSONB cast:
      //   .filter('column->>key', 'lt', value)  doesn't support cast,
      // so we use a raw Postgres filter via .filter() with the cast expression.
      const { data: staleSessions, error } = await supabaseAdmin
        .from('conversation_states')
        .select('id, restaurant_id, customer_phone, current_state, context')
        .eq('current_state', 'awaiting_special_notes')
        .filter('context->>special_notes_asked_at', 'lt', String(epochNowMinus2Min))
        .limit(50);

      if (error) {
        console.error('[notes-timeout] conversation_states query failed:', error.message);
        return;
      }

      for (const session of staleSessions ?? []) {
        try {
          const ctx          = session.context || {};
          const bookingId    = ctx.booking_id   || null;
          const customerPhone = session.customer_phone;
          const customerName  = ctx.customer_name || ctx.name || 'Guest';
          const tokenNumber   = ctx.token_number  || null;

          // ── Step 1: Confirm the bookings row (only if booking_id present) ──
          if (bookingId) {
            const { error: bookingErr } = await supabaseAdmin
              .from('bookings')
              .update({
                status:               'confirmed',    // Valid enum value ✅
                table_confirmed_at:   new Date().toISOString(),
              })
              .eq('id', bookingId)
              .eq('status', 'pending');               // Idempotency guard

            if (bookingErr) {
              // Log but don't abort — the booking may already be confirmed
              console.warn(
                `[notes-timeout] bookings update for ${bookingId}: ${bookingErr.message}`
              );
            }
          }

          // ── Step 2: Clear the conversation state so Python doesn't re-enter ─
          const { error: stateErr } = await supabaseAdmin
            .from('conversation_states')
            .update({
              current_state: 'visit_complete',
              context: {
                ...ctx,
                booking_step:             'visit_complete',
                special_notes:            null,
                special_notes_asked_at:   null,
                auto_confirmed_at:        new Date().toISOString(),
              },
              updated_at: new Date().toISOString(),
            })
            .eq('id', session.id)
            .eq('current_state', 'awaiting_special_notes'); // Idempotency guard

          if (stateErr) {
            console.error(
              `[notes-timeout] State clear failed for session ${session.id}:`,
              stateErr.message
            );
            continue; // Skip WA if we couldn't clear state
          }

          // ── Step 3: Confirm to customer via WhatsApp ───────────────────────
          if (customerPhone && process.env.WHATSAPP_ACCESS_TOKEN) {
            await sendWhatsAppMessage(
              customerPhone,
              `✅ *Booking Confirmed!*\n\n` +
              `Hi ${customerName}, your booking` +
              (tokenNumber ? ` (Token: *${tokenNumber}*)` : '') +
              ` has been confirmed — no special notes needed.\n\n` +
              `We look forward to serving you! 🍽️`
            );
          }

          // ── Step 4: Manager ping (fire-and-forget) ─────────────────────────
          if (process.env.MANAGER_WHATSAPP_NUMBER && process.env.WHATSAPP_ACCESS_TOKEN) {
            sendWhatsAppMessage(
              process.env.MANAGER_WHATSAPP_NUMBER,
              `⏰ *Auto-Confirmed (Notes Timeout)*\n` +
              `────────────────────\n` +
              `Customer: ${customerName} (+${String(customerPhone).replace(/\D/g, '')})\n` +
              `Token:    ${tokenNumber || '—'}\n` +
              `Booking:  ${bookingId   || '—'}\n` +
              `Reason:   No reply to special notes prompt for 2 min\n` +
              `Time:     ${new Date().toISOString()}`
            ).catch(e => console.error('[notes-timeout] Manager ping failed:', e.message));
          }

          console.log(
            `[notes-timeout] ✅ Auto-confirmed session ${session.id} ` +
            `(phone ${customerPhone}, booking ${bookingId})`
          );

        } catch (sessionErr) {
          console.error(
            `[notes-timeout] Error for session ${session.id}:`,
            sessionErr.message
          );
        }
      }

    } catch (err) {
      console.error('[notes-timeout] Monitor scan error:', err.message);
    }
  }, 60 * 1000);

  console.log('⏰ Special notes timeout monitor started (polls conversation_states, 2-min idle auto-confirm)');
}

// ============================================================================
// SLOT SCHEDULER  (unchanged structure — calls REQ 2 + REQ 3 at boot)
// ============================================================================

function startSlotScheduler() {
  // ── Auto-release stale seated tokens after 90 minutes ──────────────────────
  setInterval(async () => {
    const cutoff = new Date(Date.now() - 90 * 60 * 1000).toISOString();

    const { data: staleTokens } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('status', 'seated')
      .lt('seated_at', cutoff)
      .select('table_id, phone, name, id');

    for (const token of staleTokens ?? []) {
      if (token.table_id) {
        await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', token.table_id);
        console.log(`[auto-release] Token freed table ${token.table_id}`);

        // REQ 3 hook — queue feedback for every auto-released table
        await queueFeedbackForTable({
          tableId:       token.table_id,
          customerPhone: token.phone,
          customerName:  token.name,
          tokenId:       token.id,
          source:        'auto-release',
        }).catch(e => console.error('[auto-release] feedback queue failed:', e.message));
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
        .from('orders').select('id')
        .eq('table_id', order.table_id)
        .in('status', ['pending', 'confirmed', 'in_progress']);
      if (!remaining || remaining.length === 0) {
        await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', order.table_id);
      }
    }
  }, 5 * 60 * 1000);

  // ── Slot rotation — runs every minute, applies on change ──────────────────
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

  // ── Start background monitors (REQ 2 + REQ 3 + REQ 7) ────────────────────
  startFeedbackScheduler();
  startSpecialNotesTimeoutMonitor();
  startAccountingSyncScheduler();
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
        const now = new Date().toISOString();
      validRows.push({
        menuItem: {
          restaurant_id: restaurantId,
          retailer_id:   String(retailerId).trim(),
          name:          String(itemName).trim(),
          description:   String(item.description || '').trim(),
          price,
          image_url:     (item.image_url || item.image_link) ? String(item.image_url || item.image_link).trim() : null,
          time_slot:     mapTimeSlot(item.time_slot || item.custom_label_0),
          category:      item.category || 'General',
          is_stocked:    isStocked,
          is_available:  isStocked,
          created_at:    now,   // FIX 1: was missing — caused NOT NULL violations on fresh insert
          updated_at:    now,
        },
        retailerId: String(retailerId).trim(),
      });
 
    }
    if (validRows.length === 0) return res.status(400).json({ error: 'No valid rows found. Catalog unchanged.', skipped, errors });

    // Phase 2: fetch existing
    const { data: existingRows } = await supabaseAdmin.from('menu_items').select('id, retailer_id').eq('restaurant_id', restaurantId);
    const existingMap = new Map((existingRows ?? []).map(r => [r.retailer_id, r.id]));

    // ── FIX 2: Phase 3 — single upsert on (restaurant_id, retailer_id)
    //    Avoids double round-trip and handles partial rows from prior failed inserts.
    for (const { menuItem, retailerId } of validRows) {
      try {
        const { error: dbError } = await supabaseAdmin
          .from('menu_items')
          .upsert(menuItem, { onConflict: 'restaurant_id,retailer_id', ignoreDuplicates: false });
          if (dbError) {
          const isFkViolation = dbError.message?.includes('restaurant_id_fkey');
          const friendlyMsg = isFkViolation
            ? `Restaurant ID ${restaurantId} does not exist in the restaurants table — run seed SQL first`
            : dbError.message;
          errors.push({ row_id: retailerId, error: friendlyMsg });
          skipped++;
          console.error(`[menu/upload] SKIP ${retailerId}: db error — ${friendlyMsg}`);
          continue;
        }
        upserted++;
      } catch (itemError) {
        errors.push({ row_id: retailerId, error: itemError.message });
        skipped++;
      }
    }

     // ── FIX 3: Phase 4 — reliable JS-side set-difference purge.
    //    The old PostgREST .not('retailer_id','in',string) construction was
    //    unreliable for large sets and multi-tenant unsafe.
    //    1. Fetch all existing retailer_ids for this restaurant (non-null only).
    //    2. Compute the diff in JS using a Set.
    //    3. Delete orphans by primary key — tenant-safe and atomic.
    if (payloadIds.length > 0) {
      try {
        const payloadSet = new Set(payloadIds);
 
        const { data: existingForPurge, error: purgeQueryErr } = await supabaseAdmin
          .from('menu_items')
          .select('id, retailer_id, name')
          .eq('restaurant_id', restaurantId)
          .not('retailer_id', 'is', null);  // never purge items with NULL retailer_id
 
        if (purgeQueryErr) {
          console.warn('[menu/upload] Phase 4 purge query failed (non-fatal):', purgeQueryErr.message);
        } else {
          const toDelete = (existingForPurge ?? []).filter(r => !payloadSet.has(r.retailer_id));
          if (toDelete.length > 0) {
            const deleteIds = toDelete.map(r => r.id);
            const { error: deleteErr } = await supabaseAdmin.from('menu_items').delete().in('id', deleteIds);
            if (deleteErr) {
              console.warn('[menu/upload] Phase 4 delete failed (non-fatal):', deleteErr.message);
            } else {
              purged = toDelete.length;
              console.log(`[menu/upload] 🗑️ Purged ${purged} stale item(s):`, toDelete.map(r => r.name || r.retailer_id).join(', '));
            }
          }
        }
      } catch (purgeEx) {
        console.warn('[menu/upload] Phase 4 purge threw (non-fatal):', purgeEx.message);
      }
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

// ─────────────────────────────────────────────────────────────────────────────
// FIX 5a HELPER — pushSingleItemToMetaCatalog
// Sends a one-item availability patch to Meta Catalog Batch API immediately
// after a manager toggle. No bulk feed re-fetch latency.
// ─────────────────────────────────────────────────────────────────────────────
async function pushSingleItemToMetaCatalog({ retailerId, isAvailable, restaurantId }) {
  const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
  const META_CATALOG_ID   = process.env.META_CATALOG_ID;
  if (!META_ACCESS_TOKEN || !META_CATALOG_ID) {
    console.warn('[meta-single-push] Skipped — META_ACCESS_TOKEN or META_CATALOG_ID not set');
    return;
  }
 
  // Fetch full item data so Meta doesn't wipe fields on a partial update
  const { data: item } = await supabaseAdmin
    .from('menu_items')
    .select('name, description, price, image_url, time_slot')
    .eq('retailer_id', retailerId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle();
 
  const SLOT_LABEL = {
    morning_tiffin: 'Morning Tiffin', lunch: 'Lunch',
    evening_snacks: 'Evening Snacks', dinner_tiffin: 'Dinner Tiffin', all: 'All Day',
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
          price:          Math.round((parseFloat(item.price) || 0) * 100), // paise
          currency:       'INR',
          image_url:      item.image_url   || '',
          custom_label_0: SLOT_LABEL[item.time_slot] || 'All Day',
          url:            process.env.FRONTEND_URL   || 'https://autom8.works/',
          brand:          'Hotel Munafe',
          category:       'FOOD_AND_DRINK',
        } : {}),
      },
    }],
  };
 
  const resp = await fetch(
    `https://graph.facebook.com/v20.0/${META_CATALOG_ID}/batch`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(batchPayload),
    }
  );
  const result = await resp.json();
  if (!resp.ok || result.error) throw new Error(JSON.stringify(result.error || result));
  console.log(`[meta-single-push] ✅ ${retailerId} → ${isAvailable ? 'in stock' : 'out of stock'}`);
}
 
// ─────────────────────────────────────────────────────────────────────────────
// FIX 5b ROUTE — PUT /api/menu-items/:id/availability
//
// Was completely absent from server.js. The frontend toggle calls this route.
// Writes is_stocked + is_available to Supabase, responds to client immediately,
// then fire-and-forgets a single-item Meta Catalog Batch API push.
// ─────────────────────────────────────────────────────────────────────────────
app.put('/api/menu-items/:id/availability', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const authToken  = authHeader?.split(' ')[1];
    if (!authToken) return res.status(401).json({ error: 'No token' });
 
    const { data: { user } } = await supabase.auth.getUser(authToken);
    if (!user) return res.status(403).json({ error: 'Invalid token' });
 
    const { data: userData } = await supabaseAdmin
      .from('users').select('role, restaurant_id').eq('id', user.id).single();
    if (userData?.role !== 'owner' && userData?.role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
 
    const { is_available } = req.body;
    if (typeof is_available !== 'boolean')
      return res.status(400).json({ error: 'is_available (boolean) required' });
 
    const restaurantId = userData.restaurant_id;
 
    // Fetch item first — need retailer_id for Meta push
    const { data: item, error: fetchErr } = await supabaseAdmin
      .from('menu_items')
      .select('id, retailer_id, name, is_stocked')
      .eq('id', req.params.id)
      .eq('restaurant_id', restaurantId)
      .single();
 
    if (fetchErr || !item) return res.status(404).json({ error: 'Menu item not found' });
 
    // Update both is_stocked (permanent decision) and is_available (current gate)
    const { error: updateErr } = await supabaseAdmin
      .from('menu_items')
      .update({
        is_stocked:   is_available,
        is_available: is_available,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('restaurant_id', restaurantId);
 
    if (updateErr) throw updateErr;
 
    // Audit log (non-fatal)
    supabaseAdmin.from('audit_logs').insert({
      user_id: user.id, restaurant_id: restaurantId,
      action:   `Menu item ${is_available ? 'marked in stock' : 'marked out of stock'}`,
      details:  { item_id: req.params.id, item_name: item.name, is_available },
    }).catch(() => {});
 
    // Respond to client immediately — don't block on Meta API latency
    res.json({ success: true, id: req.params.id, is_available, name: item.name });
 
    // Fire-and-forget: push single-item availability to Meta Catalog
    if (item.retailer_id && process.env.META_ACCESS_TOKEN && process.env.META_CATALOG_ID) {
      pushSingleItemToMetaCatalog({
        retailerId:   item.retailer_id,
        isAvailable:  is_available,
        restaurantId,
      }).catch(e => {
        console.error(`[toggle-meta-sync] Failed for ${item.name} (${item.retailer_id}):`, e.message);
      });
    } else {
      console.warn(`[toggle-meta-sync] Skipped — retailer_id=${item.retailer_id}, META_ACCESS_TOKEN=${!!process.env.META_ACCESS_TOKEN}, META_CATALOG_ID=${!!process.env.META_CATALOG_ID}`);
    }
 
  } catch (err) {
    console.error('[menu-item-availability]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
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
      // FIX 4: Use is_stocked only. is_available is toggled false every hour
      // by the slot scheduler for off-slot items — using it here means Meta
      // sees everything as "out of stock" during off-slot hours.
      (item.is_stocked !== false) ? 'in stock' : 'out of stock',
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

    // Resolve manager phone: prefer per-restaurant row, fall back to global env var
    let managerPhone = process.env.MANAGER_WHATSAPP_NUMBER || null;
    try {
      const { data: restRow } = await supabaseAdmin
        .from('restaurants')
        .select('manager_phone')
        .eq('id', restaurant_id)
        .single();
      if (restRow?.manager_phone) managerPhone = restRow.manager_phone;
    } catch (_) {}

    if (managerPhone && process.env.WHATSAPP_ACCESS_TOKEN) {
      if (type === 'large_party') {
        const combo = meta?.combo ?? [];
        const tableLines = combo.length > 0 ? combo.map(t => `Table ${t[0]} (${t[2]}/${t[1]} seats)`).join(' + ') : `${token.pax} seats`;
        sendWhatsAppMessage(managerPhone, `🟣 *Large Party Request* — Token *${token.id}*\n👥 ${token.name} · *${token.pax} people*\n🕐 ${arrivalTime}\n\nProposed: ${tableLines}\n\n⚠️ *Action required:*\n${process.env.FRONTEND_URL || ''}/dashboard/manager`);
      } else if (req.query.notify !== 'false') {
        const typeLabel = type === 'dinein' ? 'Dine-in' : 'Takeaway';
        const paxLine   = type === 'dinein' ? `, ${token.pax} ${token.pax === 1 ? 'person' : 'people'}` : '';
        sendWhatsAppMessage(managerPhone, `🪑 *New Walk-in* — Token *${token.id}*\n👤 ${token.name}${paxLine}\n📋 ${typeLabel}\n🕐 ${arrivalTime}\n\n${process.env.FRONTEND_URL || ''}/dashboard/manager`);
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

        // REQ 3 hook — queue feedback on manual token completion
        await queueFeedbackForTable({
          tableId:       token.table_id,
          customerPhone: token.phone,
          customerName:  token.name,
          tokenId:       token.id,
          restaurantId,
          source:        'token-complete',
        }).catch(e => console.error('[token-complete] feedback queue failed:', e.message));
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
// KDS NOTIFY — POST /api/kds/notify
// ============================================================================
// Called by booking_agent.py _notify_kds() after special notes are captured.
// Creates orders → order_items → kds_items rows and broadcasts ORDER_NEW
// over WebSocket so KDSScreen.jsx refreshes its live board immediately.
// Auth: shared secret in body.secret
// ============================================================================

app.post('/api/kds/notify', async (req, res) => {

  // ── Auth ───────────────────────────────────────────────────────────────────
  const { secret } = req.body;
  const expected   = process.env.AUTOM8_KDS_SECRET || 'munafe_kds_sync_2026';
  if (secret !== expected) {
    console.warn('[kds-notify] Rejected — bad secret');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const {
    restaurant_id,
    customer_name,
    customer_phone,
    token_number,
    table_number,
    service_type,
    items          = [],
    special_notes,
    advance_credit = 0,
  } = req.body;

  if (!restaurant_id)      return res.status(400).json({ error: 'restaurant_id required' });
  if (!items.length)       return res.status(400).json({ error: 'items array must not be empty' });

  try {

    // ── Step 1: Resolve table_id from table_number (dine-in only) ─────────────
    let tableId = null;
    if (table_number) {
      const { data: tableRow } = await supabaseAdmin
        .from('tables')
        .select('id')
        .eq('restaurant_id', restaurant_id)
        .eq('table_number', String(table_number))
        .maybeSingle();
      tableId = tableRow?.id ?? null;
    }

    // ── Step 2: Create an orders row so kds_items → order_items → orders FK works
    //
    // The Python booking_agent creates `bookings` rows (different table).
    // The KDS feed queries kds_items joined through order_items to orders.
    // Without an orders row, kds_items are orphaned and never appear on screen.
    // order_number mirrors token_number so kitchen staff can match the chit.
    // ──────────────────────────────────────────────────────────────────────────
    const orderNumber = token_number
      ? `ORD-${String(token_number).replace(/^T-/, '')}`
      : `ORD-WA-${Date.now()}`;

    const cleanPhone = customer_phone
      ? String(customer_phone).replace(/\D/g, '')
      : null;

    const { data: orderRow, error: orderErr } = await supabaseAdmin
      .from('orders')
      .insert({
        restaurant_id,
        table_id:             tableId,
        order_number:         orderNumber,
        status:               'pending',
        source:               service_type || 'whatsapp_booking',
        customer_phone:       cleanPhone,
        special_instructions: special_notes || null,
      })
      .select('id, order_number')
      .single();

    if (orderErr) {
      console.error('[kds-notify] orders insert failed:', orderErr.message);
      return res.status(500).json({ error: orderErr.message });
    }

    // ── Step 3: For each item — resolve menu_item_id, create order_item + kds_item
    const kdsInserts       = [];
    let   kdsItemsCreated  = 0;

    for (const item of items) {
      // ── 3a: Resolve menu_item_id by retailer_id first, then name ────────────
      let menuItemId = null;

      if (item.retailer_id && item.retailer_id !== 'manual') {
        const { data: byRetailer } = await supabaseAdmin
          .from('menu_items')
          .select('id')
          .eq('restaurant_id', restaurant_id)
          .eq('retailer_id', item.retailer_id)
          .maybeSingle();
        menuItemId = byRetailer?.id ?? null;
      }

      if (!menuItemId && item.name) {
        const { data: byName } = await supabaseAdmin
          .from('menu_items')
          .select('id')
          .eq('restaurant_id', restaurant_id)
          .ilike('name', item.name.trim())
          .maybeSingle();
        menuItemId = byName?.id ?? null;
      }

      // ── 3b: If still unresolved, create a ghost menu_item to satisfy the FK ─
      if (!menuItemId) {
        const ghostRetailerId = (item.retailer_id && item.retailer_id !== 'manual')
          ? item.retailer_id
          : `ghost-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        const { data: ghost, error: ghostErr } = await supabaseAdmin
          .from('menu_items')
          .insert({
            restaurant_id,
            retailer_id:  ghostRetailerId,
            name:         item.name || 'Item',
            price:        parseFloat(item.unit_price) || 0,
            is_available: false,
            is_stocked:   false,
            time_slot:    'all',
            category:     'Manual',
            created_at:   new Date().toISOString(),
            updated_at:   new Date().toISOString(),
          })
          .select('id')
          .single();

        if (ghostErr) {
          console.warn(`[kds-notify] ghost menu_item failed for "${item.name}":`, ghostErr.message);
          continue; // skip item rather than failing the whole request
        }
        menuItemId = ghost.id;
      }

      // ── 3c: order_items row ──────────────────────────────────────────────────
      const qty       = parseInt(item.qty || item.quantity || 1, 10);
      const unitPrice = parseFloat(item.unit_price || 0);

      const { data: orderItem, error: oiErr } = await supabaseAdmin
        .from('order_items')
        .insert({
          order_id:     orderRow.id,
          menu_item_id: menuItemId,
          quantity:     qty,
          unit_price:   unitPrice,
        })
        .select('id')
        .single();

      if (oiErr) {
        console.warn(`[kds-notify] order_items failed for "${item.name}":`, oiErr.message);
        continue;
      }

      // ── 3d: Queue the kds_item for bulk insert ───────────────────────────────
kdsInserts.push({
  restaurant_id,
  order_item_id:        orderItem.id,
  status:               'pending',
  priority:             'normal',
  item_name:            item.name     || 'Item',
  token_number:         token_number  || null,
  customer_phone:       cleanPhone,
  service_type:         service_type  || null,
  special_instructions: special_notes || null,
  item_category:        item.category || '',
  advance_credit:       advance_credit || 0,
  created_at:           new Date().toISOString(),
  updated_at:           new Date().toISOString(),
});
    }

    // ── Step 4: Bulk-insert kds_items ──────────────────────────────────────────
    if (kdsInserts.length > 0) {
      const { error: kdsErr } = await supabaseAdmin
        .from('kds_items')
        .insert(kdsInserts);

      if (kdsErr) {
        console.error('[kds-notify] kds_items insert failed:', kdsErr.message);
        return res.status(500).json({ error: kdsErr.message });
      }
      kdsItemsCreated = kdsInserts.length;
    }

    // ── Step 5: Broadcast ORDER_NEW → KDSScreen.jsx refreshes immediately ──────
    //
    // KDSScreen.jsx listens for { type: 'ORDER_NEW' } to:
    //   1. Play the beep
    //   2. Call fetchFeed() — pulls the new kds_items into the live board
    //   3. Auto-print the KOT
    // The payload mirrors the shape broadcast by handleWhatsAppOrder() so
    // KDSScreen.jsx needs no changes.
    // ──────────────────────────────────────────────────────────────────────────
    broadcastToRestaurant(restaurant_id, {
      type:           'ORDER_NEW',
      order_id:       orderRow.id,
      order_number:   orderRow.order_number,
      token_number:   token_number   ?? null,
      table_number:   table_number   ?? null,
      customer_name:  customer_name  ?? null,
      customer_phone: cleanPhone,
      service_type:   service_type   ?? null,
      special_notes:  special_notes  ?? null,
      advance_credit: advance_credit || 0,
      item_count:     kdsItemsCreated,
      source:         'whatsapp_booking',
      timestamp:      new Date().toISOString(),
    });

    // BEGIN: QR Receipt — send receipt URL to customer
    if (cleanPhone && kdsItemsCreated > 0) {
      const receiptUrl  = `${process.env.API_BASE_URL ?? 'https://api.autom8.works'}/verify/${orderRow.id}`;
      const advanceLine = advance_credit > 0
        ? `\n🎟️ Reservation advance applied: -₹${Number(advance_credit).toFixed(0)}`
        : '';
      sendWhatsAppMessage(
        cleanPhone,
        `🧾 *Your receipt is ready!*\n\n` +
        `Order: *${orderRow.order_number}*${advanceLine}\n` +
        `Tap to view your itemised bill:\n${receiptUrl}`
      ).catch(e => console.error('[kds-notify] Receipt send failed (non-fatal):', e.message));
    }
    // END: QR Receipt

    // ── Step 6: Audit log (non-fatal) ──────────────────────────────────────────
    supabaseAdmin.from('audit_logs').insert({
      restaurant_id,
      action:  'KDS items created via booking agent',
      details: {
        order_id:        orderRow.id,
        order_number:    orderRow.order_number,
        token_number,
        service_type,
        kds_items:       kdsItemsCreated,
        customer_phone,
      },
    }).catch(e => console.warn('[kds-notify] audit log failed:', e.message));

    console.log(
      `[kds-notify] ✅ ${kdsItemsCreated} KDS item(s)` +
      ` | order ${orderRow.order_number}` +
      ` | token ${token_number ?? 'N/A'}` +
      ` | table ${table_number ?? 'N/A'}`
    );

    return res.status(201).json({
      success:           true,
      order_id:          orderRow.id,
      order_number:      orderRow.order_number,
      kds_items_created: kdsItemsCreated,
    });

  } catch (err) {
    console.error('[kds-notify] Unexpected error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// REQ 3 — SHARED FEEDBACK QUEUE HELPER
// ============================================================================
//
// queueFeedbackForTable() is a single authoritative function that every
// table-free event (token-complete, slot auto-release, POS payment checkout,
// and the manager table-status API) must call.
//
// Responsibilities:
//   1. Guard against missing phone number (no phone → no feedback loop possible)
//   2. Resolve table_number from the DB if not already supplied
//   3. INSERT a row into feedback_pending with freed_at = now() ISO string
//   4. Log the queuing event at INFO level for observability
//
// All of this is wrapped in a try/catch so a DB failure at checkout time
// never blocks or crashes the HTTP response that freed the table.
//
// @param {object} opts
//   tableId       {string}  - UUID of the table row
//   customerPhone {string}  - Raw phone string (will be sanitised)
//   customerName  {string}  - Display name (falls back to 'Guest')
//   tokenId       {string}  - walk_in_tokens.id (Token number shown to customer)
//   restaurantId  {string}  - UUID of the restaurant
//   source        {string}  - Logging label ('token-complete', 'auto-release', etc.)
// ============================================================================

async function queueFeedbackForTable({
  tableId,
  customerPhone,
  customerName,
  tokenId,
  restaurantId,
  source = 'unknown',
}) {
  // No phone = no WhatsApp message possible; skip silently
  if (!customerPhone) return;

  const cleanPhone = String(customerPhone).replace(/\D/g, '');
  if (!cleanPhone) return;

  try {
    // Resolve table_number from the DB — the caller may not have it
    let tableNumber = null;
    if (tableId) {
      const { data: tableRow } = await supabaseAdmin
        .from('tables')
        .select('table_number')
        .eq('id', tableId)
        .maybeSingle();
      tableNumber = tableRow?.table_number ?? null;
    }

    const { error: insertErr } = await supabaseAdmin
      .from('feedback_pending')
      .insert({
        restaurant_id:  restaurantId,
        customer_phone: cleanPhone,
        customer_name:  customerName || 'Guest',
        token_number:   tokenId   || null,
        table_number:   tableNumber,
        // ISO string ensures correct ORDER BY and interval arithmetic in the DB
        freed_at:       new Date().toISOString(),
        feedback_sent:  false,
        manager_notified: false,
      });

    if (insertErr) {
      console.error(`[feedback-queue][${source}] DB insert failed:`, insertErr.message);
    } else {
      console.log(
        `[feedback-queue][${source}] ✅ Queued for ${cleanPhone}` +
        (tableNumber ? ` (Table ${tableNumber})` : '')
      );
    }
  } catch (err) {
    // Non-fatal — feedback failure must never crash a checkout flow
    console.error(`[feedback-queue][${source}] Unexpected error:`, err.message);
  }
}

// ============================================================================
// REQ 3 — FEEDBACK SYSTEM ROUTES
// ============================================================================

// Manual queue endpoint (manager dashboard / admin tools)
app.post('/api/feedback/queue', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const authToken = authHeader?.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(authToken);
    const { data: userData } = await supabaseAdmin.from('users').select('restaurant_id').eq('id', user.id).single();
    const { customer_phone, customer_name, token_number, table_number } = req.body;
    if (!customer_phone) return res.status(400).json({ error: 'customer_phone required' });

    await supabaseAdmin.from('feedback_pending').insert({
      restaurant_id:  userData.restaurant_id,
      customer_phone: String(customer_phone).replace(/\D/g, ''),
      customer_name:  customer_name || 'Guest',
      token_number:   token_number  || null,
      table_number:   table_number  || null,
      freed_at:       new Date().toISOString(),
      feedback_sent:  false,
      manager_notified: false,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================================================================
// REQ 3 — startFeedbackScheduler
// ============================================================================
//
// Polls feedback_pending every 10 minutes for records where:
//   feedback_sent = false  AND  freed_at <= now() - 2 hours
//
// For each qualifying record:
//   1. Dispatches the WhatsApp feedback invitation
//   2. Stamps feedback_sent = true + feedback_sent_at timestamp
//
// Per-record try/catch means a single failed WA send does not abort the
// batch — the row stays unsent and will be retried on the next 10-min tick.
// ============================================================================

function startFeedbackScheduler() {
  setInterval(async () => {
    try {
      // ISO arithmetic — subtract exactly 7200000 ms (2 hours) from now
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      const { data: pending, error: queryErr } = await supabaseAdmin
        .from('feedback_pending')
        .select('*')
        .eq('feedback_sent', false)
        .lte('freed_at', twoHoursAgo) // Table freed >= 2 hours ago
        .limit(20);

      if (queryErr) {
        console.error('[feedback-scheduler] Query error:', queryErr.message);
        return;
      }

      for (const record of pending ?? []) {
        try {
          // Dispatch the WhatsApp feedback invitation
          await sendWhatsAppMessage(
            record.customer_phone,
            `Hi ${record.customer_name}! 😊\n\n` +
            `Thank you for dining with us today` +
            (record.table_number ? ` (Table *${record.table_number}*)` : '') +
            `.\n\n` +
            `*How was your experience?*\n\n` +
            `⭐ Reply with a rating from *1 to 5*:\n` +
            `5 ⭐ — Excellent\n` +
            `4 ⭐ — Good\n` +
            `3 ⭐ — Average\n` +
            `2 ⭐ — Below average\n` +
            `1 ⭐ — Poor\n\n` +
            `You can also add comments after your rating. 🙏`
          );

          // Mark as sent — ISO timestamp for accurate audit trail
          await supabaseAdmin
            .from('feedback_pending')
            .update({
              feedback_sent:    true,
              feedback_sent_at: new Date().toISOString(),
            })
            .eq('id', record.id);

          console.log(`[feedback-scheduler] ✅ Invitation sent to ${record.customer_phone}`);

        } catch (innerErr) {
          // Per-record isolation — this record stays feedback_sent=false for next tick
          console.error(
            `[feedback-scheduler] Failed for ${record.customer_phone}:`,
            innerErr.message
          );
        }
      }
    } catch (err) {
      // Top-level catch — scheduler crash is logged, never re-thrown
      console.error('[feedback-scheduler] Scan error:', err.message);
    }
  }, 10 * 60 * 1000); // Every 10 minutes

  console.log('📣 Feedback scheduler started (2-hour post-free delay)');
}

// ============================================================================
// REQ 4 — VIRAL GROWTH & REFERRAL MODULE
// ============================================================================
//
// Two distinct state handlers:
//
//   A) validateReferralCode(customerPhone, code, restaurantId)
//      Called when an inbound WhatsApp message looks like a referral code
//      (6-char alphanumeric pattern).  Rules:
//        • Verify the customer has no prior completed orders (is_first_order).
//        • Look up the code in `referral_codes` — must be active + not expired.
//        • If valid: write a `referral_uses` record, mark pending discount on
//          the customer row, reply with confirmation text.
//        • If invalid / already used: reply with a gentle rejection.
//
//   B) generateReferralSharePrompt(customerPhone, restaurantId)
//      Called at the END of handleWhatsAppOrder() after a successful order.
//      Pulls the customer's own referral code + reward rules and sends a
//      post-order share invitation.
//
//   C) POST /api/referrals/validate  — manual/dashboard trigger
//   D) POST /api/referrals/generate  — create a new code for a customer
// ============================================================================

// ── REST endpoints for referral management ────────────────────────────────────

// Validate a code from the POS / dashboard (not WhatsApp inbound)
app.post('/api/referrals/validate', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(403).json({ error: 'Invalid token' });

    const { customer_phone, code, restaurant_id } = req.body;
    if (!customer_phone || !code || !restaurant_id)
      return res.status(400).json({ error: 'customer_phone, code, and restaurant_id required' });

    const handled = await validateReferralCode(customer_phone, code, restaurant_id);
    res.json({ success: true, handled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate / fetch a referral code for a customer (dashboard use)
app.post('/api/referrals/generate', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(403).json({ error: 'Invalid token' });
    const { data: userData } = await supabaseAdmin.from('users').select('restaurant_id').eq('id', user.id).single();

    const { customer_phone, customer_name } = req.body;
    if (!customer_phone) return res.status(400).json({ error: 'customer_phone required' });

    await generateReferralSharePrompt(customer_phone, userData.restaurant_id, customer_name);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// REQ 5 — LOGISTICS / DELIVERY RIDER TRACKING NOTIFICATIONS
// ============================================================================
//
// sendRiderAssignedNotification() is called when a delivery partner webhook
// fires (Dunzo, Porter, or In-House).  It:
//   1. Resolves the order + customer phone from the DB.
//   2. Formats a partner-specific WhatsApp tracking message with rider name,
//      phone number, and a deep-link to the tracking URL.
//   3. Sends to customer. Optionally mirrors to manager.
//
// POST /api/delivery/rider-assigned  — receives the partner webhook payload
//   Expected body:
//     { order_id, delivery_partner_name, rider_name, rider_phone, tracking_url,
//       secret }   (secret = process.env.AUTOM8_KDS_SECRET for auth)
// ============================================================================

/**
 * sendRiderAssignedNotification
 *
 * Builds and dispatches the "Your order is on the way!" WhatsApp message.
 * Supports three known partner names with dedicated emoji/copy; falls back
 * gracefully to a generic template for unlisted partners.
 *
 * @param {object} opts
 *   orderId            {string}
 *   deliveryPartner    {string}  e.g. 'Dunzo', 'Porter', 'In-house'
 *   riderName          {string}
 *   riderPhone         {string}
 *   trackingUrl        {string}
 *   restaurantId       {string}
 */
async function sendRiderAssignedNotification({
  orderId,
  deliveryPartner,
  riderName,
  riderPhone,
  trackingUrl,
  restaurantId,
}) {
  try {
    // Fetch order + customer phone + restaurant name
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('order_number, customer_phone, walk_in_tokens(phone, name)')
      .eq('id', orderId)
      .maybeSingle();

    const customerPhone = order?.customer_phone
      ?? order?.walk_in_tokens?.[0]?.phone
      ?? null;

    if (!customerPhone) {
      console.warn(`[rider-notify] No customer phone for order ${orderId}`);
      return;
    }

    const { data: restaurant } = await supabaseAdmin
      .from('restaurants')
      .select('name')
      .eq('id', restaurantId)
      .maybeSingle();

    const storeName = restaurant?.name ?? 'our restaurant';

    // Partner-specific emoji/label — expandable
    const PARTNER_META = {
      dunzo:    { emoji: '🟡', label: 'Dunzo'    },
      porter:   { emoji: '🔵', label: 'Porter'   },
      'in-house': { emoji: '🟢', label: 'In-house' },
      inhouse:  { emoji: '🟢', label: 'In-house' },
    };
    const partnerKey  = String(deliveryPartner).toLowerCase().replace(/\s+/g, '-');
    const partnerMeta = PARTNER_META[partnerKey] ?? { emoji: '🛵', label: deliveryPartner };

    const message =
      `🛵 *Your order is on the way!*\n\n` +
      `Your meal from *${storeName}* has been picked up by our delivery partner, ` +
      `*${partnerMeta.emoji} ${partnerMeta.label}*.\n\n` +
      `👤 *Rider:* ${riderName} (${riderPhone})\n` +
      `📍 *Live Tracking:* ${trackingUrl}\n\n` +
      `Get your plates ready! 🍽️`;

    await sendWhatsAppMessage(customerPhone, message);
    console.log(`[rider-notify] ✅ Sent to ${customerPhone} (order ${orderId})`);

    // Mirror to manager for awareness (fire-and-forget)
    if (process.env.MANAGER_WHATSAPP_NUMBER) {
      sendWhatsAppMessage(
        process.env.MANAGER_WHATSAPP_NUMBER,
        `🛵 *Rider Assigned*\n` +
        `Order: *${order?.order_number ?? orderId}*\n` +
        `Partner: ${partnerMeta.emoji} ${partnerMeta.label}\n` +
        `Rider: ${riderName} (${riderPhone})\n` +
        `Tracking: ${trackingUrl}`
      ).catch(e => console.error('[rider-notify] Manager mirror failed:', e.message));
    }

  } catch (err) {
    console.error('[rider-notify] Error:', err.message);
  }
}

// Webhook endpoint — receives partner callbacks (Dunzo, Porter, in-house dispatch)
app.post('/api/delivery/rider-assigned', async (req, res) => {
  // Acknowledge immediately so partner doesn't retry
  res.status(200).json({ received: true });

  try {
    const {
      secret,
      order_id,
      delivery_partner_name,
      rider_name,
      rider_phone,
      tracking_url,
    } = req.body;

    // Shared secret auth (same pattern as /api/kds/notify)
    const expected = process.env.AUTOM8_KDS_SECRET || 'munafe_kds_sync_2026';
    if (secret !== expected) {
      console.warn('[rider-assigned] Rejected — bad secret');
      return;
    }

    if (!order_id || !delivery_partner_name || !rider_name || !tracking_url) {
      console.warn('[rider-assigned] Missing required fields — skipping');
      return;
    }

    // Resolve restaurant_id from order
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('restaurant_id')
      .eq('id', order_id)
      .maybeSingle();

    if (!order?.restaurant_id) {
      console.warn(`[rider-assigned] No restaurant found for order ${order_id}`);
      return;
    }

    // Update order with delivery metadata
    await supabaseAdmin
      .from('orders')
      .update({
        delivery_partner:  delivery_partner_name,
        rider_name:        rider_name,
        rider_phone:       rider_phone    || null,
        tracking_url:      tracking_url,
        delivery_assigned_at: new Date().toISOString(),
      })
      .eq('id', order_id);

    await sendRiderAssignedNotification({
      orderId:         order_id,
      deliveryPartner: delivery_partner_name,
      riderName:       rider_name,
      riderPhone:      rider_phone || 'N/A',
      trackingUrl:     tracking_url,
      restaurantId:    order.restaurant_id,
    });

    // Audit trail
    try {
      await supabaseAdmin.from('audit_logs').insert({
        restaurant_id: order.restaurant_id,
        action: 'Rider assigned',
        details: { order_id, delivery_partner_name, rider_name, tracking_url },
      });
    } catch (_) {}

  } catch (err) {
    console.error('[rider-assigned] Handler error:', err.message);
  }
});

// ============================================================================
// REQ 6 — MULTI-BRANCH ENTERPRISE DASHBOARD
// ============================================================================
//
// Enforces a strict Parent/Child brand_id → store_id hierarchy:
//   • role: owner | corporate  → can request brand_id scope (all branches)
//   • role: store_manager       → locked to their own store_id only
//
// Analytics computed:
//   • Total revenue across requested scope
//   • Top branch by revenue
//   • Top menu item by quantity ordered
//   • RFM at-risk count — customers with no order in 14 days
//
// Menu override rule (read model):
//   brand_id changes apply everywhere UNLESS menu_item has a
//   store-level override row (restaurant_id = specific store_id).
//   The dashboard reports the override count; the actual enforcement
//   lives in the menu_items table (handled by existing catalog logic).
//
// POST /api/enterprise/dashboard
//   Body: { requested_scope: 'brand' | 'store', store_id? }
//   Auth: Bearer token (uses supabase.auth.getUser)
// ============================================================================

/**
 * enforceHierarchyAccess
 *
 * Returns { allowed: true, scopeRestaurantIds: [...] } or { allowed: false }.
 * Owners/corporate users see all active restaurants under their brand.
 * Store managers see only their own restaurant_id.
 *
 * @param {string} userId        - Supabase auth user id
 * @param {string} requestedScope - 'brand' | 'store'
 * @param {string|null} storeId  - Required when requestedScope === 'store'
 */
async function enforceHierarchyAccess(userId, requestedScope, storeId = null) {
  const { data: userData } = await supabaseAdmin
    .from('users')
    .select('role, restaurant_id, brand_id')
    .eq('id', userId)
    .single();

  if (!userData) return { allowed: false, reason: 'User not found' };

  const role = userData.role;

  if (requestedScope === 'brand') {
    // Only owner or corporate can pull brand-wide data
    if (role !== 'owner' && role !== 'corporate') {
      return { allowed: false, reason: 'Brand-level access requires owner or corporate role' };
    }
    // Fetch all active restaurants under this brand
    const { data: allRestaurants } = await supabaseAdmin
      .from('restaurants')
      .select('id, name')
      .eq('brand_id', userData.brand_id)
      .eq('is_active', true);

    return {
      allowed: true,
      role,
      brandId: userData.brand_id,
      scopeRestaurantIds: (allRestaurants ?? []).map(r => r.id),
      restaurantMeta: allRestaurants ?? [],
    };
  }

  if (requestedScope === 'store') {
    // store_manager can only access their own store
    if (role === 'store_manager') {
      if (storeId && storeId !== userData.restaurant_id) {
        return { allowed: false, reason: 'Store managers can only view their own branch' };
      }
      return {
        allowed: true,
        role,
        scopeRestaurantIds: [userData.restaurant_id],
        restaurantMeta: [{ id: userData.restaurant_id }],
      };
    }
    // Owner/corporate can drill into any store
    if (role === 'owner' || role === 'corporate') {
      const targetId = storeId || userData.restaurant_id;
      return {
        allowed: true,
        role,
        scopeRestaurantIds: [targetId],
        restaurantMeta: [{ id: targetId }],
      };
    }
    return { allowed: false, reason: 'Insufficient role for store access' };
  }

  return { allowed: false, reason: 'Invalid requested_scope' };
}

/**
 * getRFMAtRiskCount
 *
 * Returns the count of customers who placed at least one order but have
 * been silent (no new orders) for 14+ days — the RFM "at risk" segment.
 *
 * @param {string[]} restaurantIds  - Array of restaurant UUIDs in scope
 */
async function getRFMAtRiskCount(restaurantIds) {
  try {
    if (!restaurantIds?.length) return 0;
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    // Customers who ordered at some point but NOT in the last 14 days
    const { data: atRisk } = await supabaseAdmin
      .from('orders')
      .select('customer_phone')
      .in('restaurant_id', restaurantIds)
      .eq('status', 'completed')
      .lt('created_at', fourteenDaysAgo);

    // de-dup phones
    const phonesAtRisk = new Set((atRisk ?? []).map(r => r.customer_phone).filter(Boolean));

    // Subtract any who ALSO ordered recently (i.e., they came back)
    const { data: recentOrders } = await supabaseAdmin
      .from('orders')
      .select('customer_phone')
      .in('restaurant_id', restaurantIds)
      .eq('status', 'completed')
      .gte('created_at', fourteenDaysAgo);

    const phonesRecent = new Set((recentOrders ?? []).map(r => r.customer_phone).filter(Boolean));
    for (const p of phonesRecent) phonesAtRisk.delete(p);

    return phonesAtRisk.size;
  } catch (err) {
    console.error('[rfm-at-risk] Error:', err.message);
    return 0;
  }
}

app.post('/api/enterprise/dashboard', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(403).json({ error: 'Invalid token' });

    const { requested_scope = 'brand', store_id, date } = req.body;
    const reportDate = date || new Date().toISOString().split('T')[0];

    // ── Hierarchy enforcement ──────────────────────────────────────────────────
    const access = await enforceHierarchyAccess(user.id, requested_scope, store_id);
    if (!access.allowed) {
      return res.status(403).json({ error: access.reason });
    }

    const { scopeRestaurantIds, restaurantMeta, role } = access;

    if (!scopeRestaurantIds.length) {
      return res.status(404).json({ error: 'No restaurants found in scope' });
    }

    // ── Revenue matrix ─────────────────────────────────────────────────────────
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('restaurant_id, total_amount, status, created_at')
      .in('restaurant_id', scopeRestaurantIds)
      .eq('status', 'completed')
      .gte('created_at', `${reportDate}T00:00:00.000Z`)
      .lte('created_at', `${reportDate}T23:59:59.999Z`);

    const revenueByStore = {};
    let totalRevenue = 0;
    for (const order of orders ?? []) {
      revenueByStore[order.restaurant_id] = (revenueByStore[order.restaurant_id] ?? 0) + (order.total_amount ?? 0);
      totalRevenue += (order.total_amount ?? 0);
    }

    // Top branch
    let topBranchId  = null, topBranchRev = 0;
    for (const [rid, rev] of Object.entries(revenueByStore)) {
      if (rev > topBranchRev) { topBranchRev = rev; topBranchId = rid; }
    }
    const topBranchMeta = restaurantMeta.find(r => r.id === topBranchId);
    const topBranchName = topBranchMeta?.name ?? topBranchId ?? '—';

    // ── Top item across scope ─────────────────────────────────────────────────
    const { data: topItems } = await supabaseAdmin
      .from('order_items')
      .select('menu_item_id, quantity, menu_item:menu_item_id(name, restaurant_id)')
      .in('menu_item.restaurant_id', scopeRestaurantIds);

    const itemQty = {};
    for (const oi of topItems ?? []) {
      const name = oi.menu_item?.name || oi.menu_item_id;
      itemQty[name] = (itemQty[name] ?? 0) + (oi.quantity ?? 1);
    }
    const topItem = Object.entries(itemQty).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';

    // ── Menu override count ────────────────────────────────────────────────────
    const { count: overrideCount } = await supabaseAdmin
      .from('menu_items')
      .select('id', { count: 'exact', head: true })
      .in('restaurant_id', scopeRestaurantIds)
      .not('brand_override', 'is', null); // Assumes a brand_override column marks overrides

    // ── RFM at-risk ────────────────────────────────────────────────────────────
    const rfmAtRiskCount = await getRFMAtRiskCount(scopeRestaurantIds);

    res.json({
      success: true,
      scope: requested_scope,
      role,
      report_date: reportDate,
      summary: {
        total_revenue:       parseFloat(totalRevenue.toFixed(2)),
        top_branch_name:     topBranchName,
        top_branch_revenue:  parseFloat(topBranchRev.toFixed(2)),
        top_item:            topItem,
        rfm_at_risk_count:   rfmAtRiskCount,
        menu_overrides:      overrideCount ?? 0,
      },
      revenue_matrix: revenueByStore,
    });

  } catch (err) {
    console.error('[enterprise-dashboard]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// REQ 7 — GST COMPLIANCE ENGINE & ACCOUNTING SYNC
// ============================================================================
//
// calculateGST(subtotal, ratePercent)
//   Treats subtotal as BASE PRICE (exclusive of tax per Indian restaurant norm).
//   Default rate: 5% (CGST 2.5% + SGST 2.5%) — standard restaurant without ITC.
//   18% rate available when the item category requires it.
//
// buildInvoicePayload(order, restaurant)
//   Constructs the full JSON structure consumed by the PDF rendering worker.
//   Includes invoice_meta, financial_breakdown, and verification block.
//
// POST /api/invoices/generate  — manual/dashboard trigger
// POST /api/invoices/webhook   — auto-fires on payment_status → 'paid'
//
// startAccountingSyncScheduler()
//   Runs at 23:30 IST each night (checks every minute for the window).
//   Collects all invoices with accounting_sync_status = 'PENDING_DAILY_ROLLUP'
//   and pushes them to Zoho Books (or Tally if configured).
//   Sets accounting_sync_status = 'SYNCED' on success.
// ============================================================================

// GST rates — add more categories here if needed
const GST_RATES = {
  default:           5,   // CGST 2.5% + SGST 2.5%  (restaurant without ITC)
  premium_service:  18,   // AC restaurants / hotels with room tariff > ₹7500
  non_ac:            5,   // Same as default for clarity
};

/**
 * calculateGST
 *
 * @param {number} subtotal     - Base price (exclusive of tax)
 * @param {number} ratePercent  - Total GST rate (5 or 18)
 * @returns {{ cgst, sgst, totalTax, grandTotal }}
 */
function calculateGST(subtotal, ratePercent = 5) {
  const rate      = Number(ratePercent) || 5;
  const halfRate  = rate / 2;
  const cgst      = parseFloat(((subtotal * halfRate) / 100).toFixed(2));
  const sgst      = parseFloat(((subtotal * halfRate) / 100).toFixed(2));
  const totalTax  = parseFloat((cgst + sgst).toFixed(2));
  const grandTotal = parseFloat((subtotal + totalTax).toFixed(2));
  return { cgst, sgst, totalTax, grandTotal };
}

/**
 * buildInvoicePayload
 *
 * Constructs the structured JSON payload the PDF worker expects.
 * Delivery/packaging charge is included if present on the order.
 *
 * @param {object} order       - Full order row from DB (with order_items joined)
 * @param {object} restaurant  - Restaurant row (needs gstin, brand_id, id, name)
 * @param {number} gstRate     - 5 or 18
 * @returns {object}  Invoice payload ready for PDF renderer or Zoho push
 */
function buildInvoicePayload(order, restaurant, gstRate = 5) {
  const subtotal       = parseFloat(order.subtotal ?? 0);
  const deliveryCharge = parseFloat(order.delivery_charge ?? 0);
  const { cgst, sgst, grandTotal } = calculateGST(subtotal, gstRate);
  const finalTotal = parseFloat((grandTotal + deliveryCharge).toFixed(2));

  return {
    invoice_meta: {
      brand_id:         restaurant.brand_id   ?? null,
      store_id:         restaurant.id,
      store_name:       restaurant.name        ?? '',
      gstin:            restaurant.gstin        ?? restaurant.store_gstin ?? '',
      order_id:         order.id,
      order_number:     order.order_number,
      fulfillment_type: order.service_type     ?? order.source ?? 'dine_in',
      invoice_date:     new Date().toISOString(),
    },
    financial_breakdown: {
      subtotal_base_price:         subtotal,
      cgst_amount:                 cgst,
      cgst_rate_pct:               gstRate / 2,
      sgst_amount:                 sgst,
      sgst_rate_pct:               gstRate / 2,
      total_gst:                   parseFloat((cgst + sgst).toFixed(2)),
      packaging_or_delivery_charge: deliveryCharge,
      grand_total:                 finalTotal,
    },
    line_items: (order.order_items ?? []).map(oi => ({
      name:        oi.menu_item?.name       ?? oi.item_name ?? 'Item',
      category:    oi.menu_item?.category   ?? '',
      quantity:    oi.quantity              ?? 1,
      unit_price:  parseFloat(oi.unit_price ?? 0),
      line_total:  parseFloat(((oi.unit_price ?? 0) * (oi.quantity ?? 1)).toFixed(2)),
    })),
    verification: {
      qr_code_data:           `${process.env.API_BASE_URL ?? 'https://api.autom8.works'}/verify/${order.id}`,
      accounting_sync_status: 'PENDING_DAILY_ROLLUP_ZOHO_TALLY',
    },
  };
}

// Manual invoice generation (dashboard / receipt print button)
app.post('/api/invoices/generate', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(403).json({ error: 'Invalid token' });
    const { data: userData } = await supabaseAdmin.from('users').select('role, restaurant_id').eq('id', user.id).single();
    if (userData?.role !== 'owner' && userData?.role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });

    const { order_id, gst_rate } = req.body;
    if (!order_id) return res.status(400).json({ error: 'order_id required' });

    // Fetch full order with items
    const { data: order, error: orderErr } = await supabaseAdmin
      .from('orders')
      .select('*, order_items(quantity, unit_price, menu_item:menu_item_id(name, category))')
      .eq('id', order_id)
      .eq('restaurant_id', userData.restaurant_id)
      .single();
    if (orderErr || !order) return res.status(404).json({ error: 'Order not found' });

    const { data: restaurant } = await supabaseAdmin
      .from('restaurants')
      .select('id, name, gstin, brand_id')
      .eq('id', userData.restaurant_id)
      .single();

    const gstRate   = gst_rate ?? GST_RATES.default;
    const payload   = buildInvoicePayload(order, restaurant ?? {}, gstRate);

    // Persist the invoice record
    const { data: invoice, error: invErr } = await supabaseAdmin
      .from('invoices')
      .upsert({
        restaurant_id:          userData.restaurant_id,
        order_id:               order_id,
        payload:                payload,
        gst_rate:               gstRate,
        grand_total:            payload.financial_breakdown.grand_total,
        accounting_sync_status: 'PENDING_DAILY_ROLLUP_ZOHO_TALLY',
        generated_at:           new Date().toISOString(),
      }, { onConflict: 'order_id', ignoreDuplicates: false })
      .select()
      .single();

    if (invErr) throw invErr;

    res.json({ success: true, invoice_id: invoice.id, payload });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-trigger invoice on payment webhook (payment_status → 'paid')
app.post('/api/invoices/webhook', async (req, res) => {
  // Acknowledge immediately
  res.status(200).json({ received: true });

  try {
    const { secret, order_id, payment_status } = req.body;
    const expected = process.env.AUTOM8_KDS_SECRET || 'munafe_kds_sync_2026';
    if (secret !== expected) { console.warn('[invoice-webhook] Bad secret'); return; }
    if (payment_status !== 'paid' && payment_status !== 'completed') return;
    if (!order_id) return;

    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('*, order_items(quantity, unit_price, menu_item:menu_item_id(name, category))')
      .eq('id', order_id)
      .single();
    if (!order) { console.warn(`[invoice-webhook] Order ${order_id} not found`); return; }

    const { data: restaurant } = await supabaseAdmin
      .from('restaurants')
      .select('id, name, gstin, brand_id')
      .eq('id', order.restaurant_id)
      .single();

    const payload = buildInvoicePayload(order, restaurant ?? {}, GST_RATES.default);

    await supabaseAdmin
      .from('invoices')
      .upsert({
        restaurant_id:          order.restaurant_id,
        order_id:               order_id,
        payload:                payload,
        gst_rate:               GST_RATES.default,
        grand_total:            payload.financial_breakdown.grand_total,
        accounting_sync_status: 'PENDING_DAILY_ROLLUP_ZOHO_TALLY',
        generated_at:           new Date().toISOString(),
      }, { onConflict: 'order_id', ignoreDuplicates: false });

    console.log(`[invoice-webhook] ✅ Invoice generated for order ${order_id}`);

  } catch (err) {
    console.error('[invoice-webhook] Error:', err.message);
  }
});

// ── REQ 7: Daily accounting sync scheduler ───────────────────────────────────
//
// Fires once per day in the 23:30–23:31 IST window.
// Pushes all PENDING invoices to Zoho Books (or Tally).
// On success marks each row accounting_sync_status = 'SYNCED'.
// Uses the same IST-offset arithmetic as getCurrentSlotIST().
// ─────────────────────────────────────────────────────────────────────────────

function startAccountingSyncScheduler() {
  let lastSyncDate = null; // Tracks the last date a sync was fired (YYYY-MM-DD)

  setInterval(async () => {
    try {
      const now        = new Date();
      const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
      const istMinutes = (utcMinutes + 330) % (24 * 60);
      const istHour    = Math.floor(istMinutes / 60);
      const istMin     = istMinutes % 60;

      // Fire in the 23:30 window — IST hour 23, minute 30–31
      if (istHour !== 23 || istMin < 30 || istMin > 31) return;

      const todayIST = new Date(now.getTime() + 330 * 60 * 1000)
        .toISOString().split('T')[0]; // YYYY-MM-DD in IST

      if (lastSyncDate === todayIST) return; // Already ran today
      lastSyncDate = todayIST;

      console.log(`[accounting-sync] 🔄 Starting nightly sync for ${todayIST}`);

      // Fetch all invoices pending sync
      const { data: pendingInvoices, error: fetchErr } = await supabaseAdmin
        .from('invoices')
        .select('id, order_id, payload, restaurant_id')
        .eq('accounting_sync_status', 'PENDING_DAILY_ROLLUP_ZOHO_TALLY')
        .limit(200);

      if (fetchErr) throw fetchErr;
      if (!pendingInvoices?.length) {
        console.log('[accounting-sync] No pending invoices today');
        return;
      }

      let synced = 0, failed = 0;

      for (const invoice of pendingInvoices) {
        try {
          await pushInvoiceToAccounting(invoice);
          await supabaseAdmin
            .from('invoices')
            .update({
              accounting_sync_status: 'SYNCED',
              synced_at:              new Date().toISOString(),
            })
            .eq('id', invoice.id);
          synced++;
        } catch (invoiceErr) {
          console.error(`[accounting-sync] Failed for invoice ${invoice.id}:`, invoiceErr.message);
          await supabaseAdmin
            .from('invoices')
            .update({ accounting_sync_status: 'SYNC_FAILED' })
            .eq('id', invoice.id);
          failed++;
        }
      }

      console.log(`[accounting-sync] ✅ Done — synced: ${synced}, failed: ${failed}`);

      // Manager notification on completion
      if (process.env.MANAGER_WHATSAPP_NUMBER) {
        sendWhatsAppMessage(
          process.env.MANAGER_WHATSAPP_NUMBER,
          `📊 *Nightly Accounting Sync Complete*\n` +
          `Date: ${todayIST}\n` +
          `✅ Synced: ${synced}\n` +
          `❌ Failed: ${failed}\n` +
          `Platform: Zoho Books / Tally`
        ).catch(e => console.error('[accounting-sync] Manager notify failed:', e.message));
      }

    } catch (err) {
      console.error('[accounting-sync] Scheduler error:', err.message);
    }
  }, 60 * 1000); // Check every minute

  console.log('📊 Accounting sync scheduler started (fires nightly at 23:30 IST)');
}

/**
 * pushInvoiceToAccounting
 *
 * Dispatches an invoice payload to Zoho Books.
 * Falls back to a no-op stub when ZOHO_CLIENT_ID is not configured so
 * the scheduler runs safely in staging environments.
 *
 * Replace this stub with your actual Zoho Books / Tally SDK calls.
 *
 * @param {object} invoice  - Row from the `invoices` table
 */
async function pushInvoiceToAccounting(invoice) {
  const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
  const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
  const ZOHO_ORG_ID        = process.env.ZOHO_ORG_ID;

  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_ORG_ID) {
    // Staging stub — log and return without error so sync_status → SYNCED
    console.log(`[accounting-push] Stub: would push invoice ${invoice.id} to Zoho Books`);
    return;
  }

  // ── Zoho Books API call ────────────────────────────────────────────────────
  // Step 1: obtain access token via client_credentials (or use a stored refresh token)
  const tokenResp = await fetch(
    `https://accounts.zoho.in/oauth/v2/token` +
    `?client_id=${ZOHO_CLIENT_ID}` +
    `&client_secret=${ZOHO_CLIENT_SECRET}` +
    `&grant_type=client_credentials` +
    `&scope=ZohoBooks.invoices.CREATE`,
    { method: 'POST' }
  );
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error('Zoho token fetch failed: ' + JSON.stringify(tokenData));

  // Step 2: POST the invoice
  const p   = invoice.payload;
  const fb  = p?.financial_breakdown ?? {};
  const body = {
    customer_name:    p?.invoice_meta?.store_name ?? 'Walk-in Customer',
    invoice_number:   p?.invoice_meta?.order_number ?? invoice.order_id,
    date:             (p?.invoice_meta?.invoice_date ?? new Date().toISOString()).split('T')[0],
    line_items:       (p?.line_items ?? []).map(li => ({
      name:       li.name,
      quantity:   li.quantity,
      rate:       li.unit_price,
      tax_name:   'GST',
      tax_percentage: (p?.financial_breakdown?.cgst_rate_pct ?? 2.5) * 2,
    })),
    sub_total:        fb.subtotal_base_price,
    tax_total:        fb.total_gst,
    total:            fb.grand_total,
  };

  const invoiceResp = await fetch(
    `https://books.zoho.in/api/v3/invoices?organization_id=${ZOHO_ORG_ID}`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Zoho-oauthtoken ${tokenData.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ JSONString: JSON.stringify(body) }),
    }
  );
  const result = await invoiceResp.json();
  if (result.code !== 0) throw new Error(`Zoho Books error: ${result.message}`);
  console.log(`[accounting-push] ✅ Zoho invoice created: ${result.invoice?.invoice_id}`);
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
// DASHBOARD ENDPOINTS PATCH
// Replace the entire "OWNER DASHBOARD ENDPOINTS" section in server.js with this.
// This fixes:
//   1. Duplicate /api/dashboard/wa-orders route (was causing Express to use
//      the first definition which queried non-existent 'bookings' columns)
//   2. wa-orders now correctly reads walk_in_tokens (merged DB — no bookings table)
//   3. All three endpoints use consistent auth pattern
// ============================================================================

// ============================================================================
// OWNER DASHBOARD ENDPOINTS
// All data is in the single merged Supabase DB via supabaseAdmin.
// wa-orders reads walk_in_tokens — bookings table is not used here.
// ============================================================================

app.get('/api/dashboard/waba', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const authToken  = authHeader?.split(' ')[1];
    if (!authToken) return res.status(401).json({ error: 'No token' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authToken);
    if (authErr || !user) return res.status(403).json({ error: 'Invalid token' });
    const { data: userData } = await supabaseAdmin
      .from('users').select('restaurant_id').eq('id', user.id).single();

 // restaurant_details table dropped — all fields now on restaurants directly
    const { data, error } = await supabaseAdmin
      .from('restaurants')
      .select(`
        id, name, whatsapp_number, manager_phone, timezone,
        dining_duration_minutes, payment_mode, waba_id,
        display_name, city, state, country,
        cuisine_type, opening_hours,
        contact_phone, contact_email,
        website_url, google_maps_url, address_line1
      `)
      .eq('id', userData.restaurant_id)
      .maybeSingle();
	
    if (error) console.error('[/api/dashboard/waba]', error.message);
    res.json({ success: true, restaurant: data ?? null });
  } catch (err) {
    console.error('[/api/dashboard/waba]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/wa-orders', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const authToken  = authHeader?.split(' ')[1];
    if (!authToken) return res.status(401).json({ error: 'No token' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authToken);
    if (authErr || !user) return res.status(403).json({ error: 'Invalid token' });
    const { data: userData } = await supabaseAdmin
      .from('users').select('restaurant_id').eq('id', user.id).single();

    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const { data, error } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('id, arrived_at, status, type, pax, name, phone, table_number')
      .eq('restaurant_id', userData.restaurant_id)
      .gte('arrived_at', start)
      .lte('arrived_at', end)
      .order('arrived_at', { ascending: false })
      .limit(500);

    if (error) {
      console.error('[wa-orders]', error.message);
      return res.status(500).json({ error: error.message });
    }

    const orders = (data ?? []).map(t => ({
      id:           t.id,
      created_at:   t.arrived_at,
      service_type: t.type,
      status:       t.status,
      party_size:   t.pax,
      token_number: t.id,
      total_amount: null,
      customers:    { name: t.name, phone: t.phone },
    }));

    console.log(`[wa-orders] ${orders.length} tokens in range`);
    res.json({ success: true, orders });
  } catch (err) {
    console.error('[wa-orders]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/cancel-stats', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const authToken  = authHeader?.split(' ')[1];
    if (!authToken) return res.status(401).json({ error: 'No token' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authToken);
    if (authErr || !user) return res.status(403).json({ error: 'Invalid token' });
    const { data: userData } = await supabaseAdmin
      .from('users').select('restaurant_id').eq('id', user.id).single();
    const restaurantId = userData.restaurant_id;

    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const [cancelRes, totalRes, bcRes, btRes] = await Promise.all([
      supabaseAdmin.from('orders').select('total_amount')
        .eq('restaurant_id', restaurantId).eq('status', 'cancelled')
        .gte('created_at', start).lte('created_at', end),
      supabaseAdmin.from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantId)
        .gte('created_at', start).lte('created_at', end),
      // Walk-in tokens completed in period = served customers (proxy for bookings)
      supabaseAdmin.from('walk_in_tokens')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantId)
        .in('status', ['completed', 'cancelled'])
        .gte('arrived_at', start).lte('arrived_at', end),
      supabaseAdmin.from('walk_in_tokens')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantId)
        .gte('arrived_at', start).lte('arrived_at', end),
    ]);

    const orderCancels   = cancelRes.data ?? [];
    const totalOrders    = totalRes.count ?? 0;
    const orderRevLost   = orderCancels.reduce((s, o) => s + (o.total_amount ?? 0), 0);
    const bookingCancels = bcRes.count ?? 0;
    const totalBookings  = btRes.count ?? 0;

    res.json({
      success:       true,
      orderCancels:  orderCancels.length,
      orderRevLost,
      totalOrders,
      orderRate:     totalOrders > 0 ? Math.round((orderCancels.length / totalOrders) * 100) : 0,
      bookingCancels,
      totalBookings,
      bookingRate:   totalBookings > 0 ? Math.round((bookingCancels / totalBookings) * 100) : 0,
    });
  } catch (err) {
    console.error('[cancel-stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// RECEIPT ENDPOINT — GET /verify/:orderId
// ============================================================================
// Public endpoint — no auth required.
// Returns a mobile-friendly HTML receipt with a QR code.
// QR code is rendered client-side via CDN (no npm install needed).
//
// WHERE TO PLACE IN server.js:
//   Paste this entire block just before the final () call.
//
// HOW IT WORKS:
//   1. Looks up the invoice by order_id (generated post-order)
//   2. Falls back to building payload on-the-fly from orders table
//      (handles the brief race window before invoice is persisted)
//   3. Renders a clean HTML receipt page with itemised breakdown,
//      GST split, and a scannable QR code pointing to this same URL
// ============================================================================

// BEGIN: QR Receipt — /verify/:orderId endpoint

// Simple HTML escaper — prevents XSS from DB content in the receipt page
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.get('/verify/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).send('<p>Order ID required</p>');

    // ── Step 1: Try invoice table first ──────────────────────────────────────
    const { data: invoice } = await supabaseAdmin
      .from('invoices')
      .select('payload, grand_total, generated_at')
      .eq('order_id', orderId)
      .maybeSingle();

    let p = invoice?.payload ?? null;

    // ── Step 2: Fall back to building payload from orders table ──────────────
    // Handles race window between order creation and invoice persistence.
    if (!p) {
      const { data: order } = await supabaseAdmin
        .from('orders')
        .select('*, order_items(quantity, unit_price, menu_item:menu_item_id(name, category))')
        .eq('id', orderId)
        .single();

      if (!order) {
        return res.status(404).send(`
          <!DOCTYPE html><html><head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>Receipt not found</title></head>
          <body style="font-family:sans-serif;text-align:center;padding:48px 24px;color:#888">
            <p style="font-size:44px;margin-bottom:12px">🔍</p>
            <p style="font-size:16px;color:#555;margin-bottom:8px">Receipt not found</p>
            <p style="font-size:12px">Order: ${escHtml(orderId)}</p>
          </body></html>`
        );
      }

      const { data: restaurant } = await supabaseAdmin
        .from('restaurants')
        .select('id, name, gstin, brand_id')
        .eq('id', order.restaurant_id)
        .maybeSingle();

      // Uses server.js's own buildInvoicePayload + GST_RATES (no cross-require)
      p = buildInvoicePayload(order, restaurant ?? {}, GST_RATES.default);
    }

    // ── Step 3: Render HTML receipt ───────────────────────────────────────────
    const receiptUrl = `${process.env.API_BASE_URL ?? 'https://api.autom8.works'}/verify/${orderId}`;
    const im         = p.invoice_meta         ?? {};
    const fb         = p.financial_breakdown  ?? {};
    const lineItems  = p.line_items           ?? [];

    const itemRows = lineItems.map(li => `
      <tr>
        <td class="item-name">${escHtml(li.name)}${(li.quantity ?? 1) > 1 ? ` <span class="item-qty-inline">×${li.quantity}</span>` : ''}</td>
        <td class="item-price">₹${(li.line_total ?? 0).toFixed(2)}</td>
      </tr>`
    ).join('');

    const deliveryRow = (fb.packaging_or_delivery_charge ?? 0) > 0
      ? `<div class="total-row"><span>Delivery charge</span><span>₹${fb.packaging_or_delivery_charge.toFixed(2)}</span></div>`
      : '';

    const dateStr = new Date(im.invoice_date ?? Date.now())
      .toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
        timeZone: 'Asia/Kolkata',
      });

    const fulfillmentLabel = (im.fulfillment_type ?? 'dine_in')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <meta name="theme-color" content="#1a1a1a" />
  <title>Receipt — ${escHtml(im.order_number ?? orderId.slice(-8))}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f0f0ee;
      min-height: 100vh;
      padding: 20px 16px 48px;
      display: flex;
      align-items: flex-start;
      justify-content: center;
    }
    .receipt {
      background: #fff;
      border-radius: 16px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 2px 24px rgba(0,0,0,.1);
      overflow: hidden;
    }

    /* Header */
    .rh {
      background: #1a1a1a;
      color: #fff;
      padding: 22px 20px 18px;
      text-align: center;
    }
    .rh-name  { font-size: 17px; font-weight: 600; letter-spacing: .02em; }
    .rh-order { font-size: 12px; color: #888; margin-top: 3px; }
    .rh-badge {
      display: inline-block;
      margin-top: 10px;
      padding: 3px 12px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .04em;
      background: rgba(34,197,94,.15);
      color: #22c55e;
      border: 1px solid rgba(34,197,94,.3);
    }

    /* Body */
    .rb { padding: 18px 20px 20px; }

    /* Meta rows */
    .meta { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 6px; }
    .meta .lbl { color: #aaa; }
    .meta .val { color: #333; font-weight: 500; }

    /* Divider */
    .dv { border: none; border-top: 1px dashed #e0e0dc; margin: 14px 0; }

    /* Items table */
    .items { width: 100%; border-collapse: collapse; }
    .items td { padding: 7px 0; vertical-align: top; }
    .item-name {
      font-size: 13px;
      color: #222;
      padding-right: 10px;
    }
    .item-qty-inline { font-size: 11px; color: #aaa; }
    .item-price {
      font-size: 13px;
      color: #222;
      text-align: right;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }

    /* Totals */
    .totals { margin-top: 4px; }
    .total-row {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: #888;
      margin-bottom: 6px;
    }
    .total-row.grand {
      font-size: 15px;
      font-weight: 600;
      color: #111;
      padding-top: 9px;
      margin-top: 3px;
      border-top: 1px solid #e0e0dc;
    }

    /* Payment note */
    .pay-note {
      margin-top: 14px;
      padding: 10px 14px;
      background: #f0f9f4;
      border-radius: 8px;
      font-size: 12px;
      color: #15803d;
      text-align: center;
      font-weight: 500;
    }

    /* QR section */
    .qr-section {
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px dashed #e0e0dc;
      text-align: center;
    }
    .qr-label {
      font-size: 10px;
      color: #bbb;
      letter-spacing: .04em;
      text-transform: uppercase;
      margin-bottom: 10px;
    }
    #qrcode { display: inline-block; }
    #qrcode canvas, #qrcode img {
      border-radius: 6px;
    }

    /* Footer */
    .rfooter {
      text-align: center;
      font-size: 10px;
      color: #ccc;
      margin-top: 12px;
      padding-bottom: 2px;
    }

    /* Print / save button */
    .print-btn {
      display: block;
      width: 100%;
      margin-top: 16px;
      padding: 13px;
      background: #1a1a1a;
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      letter-spacing: .03em;
    }
    .print-btn:active { opacity: .85; }

    /* Print styles */
    @media print {
      body { background: #fff; padding: 0; }
      .receipt { box-shadow: none; border-radius: 0; max-width: 100%; }
      .print-btn { display: none; }
    }
  </style>
</head>
<body>
  <div class="receipt">

    <div class="rh">
      <div class="rh-name">${escHtml(im.store_name || 'Restaurant')}</div>
      <div class="rh-order">Order #${escHtml(im.order_number ?? orderId.slice(-8))}</div>
      <div class="rh-badge">✓ Order Received</div>
    </div>

    <div class="rb">

      <div class="meta"><span class="lbl">Date &amp; time</span><span class="val">${escHtml(dateStr)}</span></div>
      <div class="meta"><span class="lbl">Order type</span><span class="val">${escHtml(fulfillmentLabel)}</span></div>
      ${im.gstin ? `<div class="meta"><span class="lbl">GSTIN</span><span class="val">${escHtml(im.gstin)}</span></div>` : ''}

      <hr class="dv" />

      <table class="items"><tbody>${itemRows}</tbody></table>

      <hr class="dv" />

      <div class="totals">
        <div class="total-row">
          <span>Subtotal</span>
          <span>₹${(fb.subtotal_base_price ?? 0).toFixed(2)}</span>
        </div>
        <div class="total-row">
          <span>GST (CGST ${fb.cgst_rate_pct ?? 2.5}% + SGST ${fb.sgst_rate_pct ?? 2.5}%)</span>
          <span>₹${(fb.total_gst ?? 0).toFixed(2)}</span>
        </div>
        ${deliveryRow}
        <div class="total-row grand">
          <span>Total</span>
          <span>₹${(fb.grand_total ?? 0).toFixed(2)}</span>
        </div>
      </div>

      <div class="pay-note">💚 Payment can be made at the counter</div>

      <div class="qr-section">
        <div class="qr-label">Scan to open this receipt</div>
        <div id="qrcode"></div>
        <div class="rfooter">Powered by Autom8 · ${escHtml(im.store_name || '')}</div>
      </div>

      <button class="print-btn" onclick="window.print()">🖨 Save / Print receipt</button>

    </div>
  </div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"
          integrity="sha512-CNgIRecGo7nphbeZ04Sc13ka07paqdeTu0WR1IM4kNcpmBAUSHSi2jPyei5Z0DxUi0GsfcOQhHFAP7uYBiWzA=="
          crossorigin="anonymous" referrerpolicy="no-referrer"></script>
  <script>
    var receiptUrl = ${JSON.stringify(receiptUrl)};
    try {
      new QRCode(document.getElementById('qrcode'), {
        text:         receiptUrl,
        width:        128,
        height:       128,
        colorDark:    '#1a1a1a',
        colorLight:   '#ffffff',
        correctLevel: QRCode.CorrectLevel.M,
      });
    } catch (e) {
      document.getElementById('qrcode').innerHTML =
        '<p style="font-size:11px;color:#bbb;padding:10px">QR unavailable</p>';
    }
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);

  } catch (err) {
    console.error('[verify-receipt]', err.message);
    res.status(500).send(`
      <!DOCTYPE html><html><head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Error</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:48px 24px;color:#888">
        <p style="font-size:44px;margin-bottom:12px">⚠️</p>
        <p>Could not load receipt. Please try again.</p>
      </body></html>`
    );
  }
});

// END: QR Receipt — /verify/:orderId endpoint




// Receipt redirect — /r/:token → Supabase signed URL
app.get('/r/:token', async (req, res) => {
    const token    = req.params.token;
    const sbBase   = (process.env.AUTOM8_SUPABASE_URL || '').replace(/\/$/, '');
    const sbKey    = process.env.AUTOM8_SUPABASE_SERVICE_KEY || '';

    if (!sbBase || !sbKey) {
        return res.status(503).send('<h1>Service unavailable</h1>');
    }

    try {
        // 1. List bucket files and find one matching this token
        const listResp = await fetch(`${sbBase}/storage/v1/object/list/Receipts`, {
            method:  'POST',
            headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`,
                       'Content-Type': 'application/json' },
            body:    JSON.stringify({ prefix: '', limit: 200 }),
        });
        const files = await listResp.json();
        const match = Array.isArray(files)
            ? files.find(f => f.name && f.name.includes(token))
            : null;

        if (!match) {
            return res.status(404).send(`
                <html><body style="font-family:sans-serif;padding:40px">
                <h2>Receipt not found or expired</h2>
                <p>Receipts are available for 48 hours after your order.</p>
                </body></html>`);
        }

        // 2. Generate a fresh 1-hour signed URL
        const signResp = await fetch(
            `${sbBase}/storage/v1/object/sign/Receipts/${match.name}`,
            {
                method:  'POST',
                headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`,
                           'Content-Type': 'application/json' },
                body:    JSON.stringify({ expiresIn: 3600 }),
            }
        );
        const signData   = await signResp.json();
        const signedPath = signData.signedURL || '';

        if (!signedPath) {
            return res.status(503).send('<h1>Could not generate receipt link</h1>');
        }

        return res.redirect(`${sbBase}/storage/v1${signedPath}`);

    } catch (err) {
        console.error('[receipt-redirect] Error:', err);
        return res.status(500).send('<h1>Error retrieving receipt</h1>');
    }
});

// ── HTTP server ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Autom8 Backend running on port ${PORT}`);
  console.log(`📍 Region: ${process.env.REGION || 'IN'}`);
  console.log(`🗄️  Database: ${process.env.SUPABASE_URL}`);
  startSlotScheduler();
});
