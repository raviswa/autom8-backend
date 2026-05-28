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
// REQ 1 — CONTEXT-AWARE CONDIMENT PROMPTS ("Sambar / Raita Nudge")
// ============================================================================
//
// These keyword sets are defined once as module-level constants so they can be
// maintained or expanded without touching the detection logic.
//
// Matching strategy: every item name + category string is lower-cased before
// the check, making all comparisons case-insensitive regardless of how the
// manager entered the menu data.
// ============================================================================

// South-Indian tiffin item keywords and slot/category labels
const SOUTH_INDIAN_ITEM_KEYWORDS = [
  'idli', 'idly', 'dosa', 'dosai', 'vada', 'vadai', 'pongal',
  'uttapam', 'upma', 'rava', 'appam', 'puttu', 'pesarattu',
  'medu', 'uthapam', 'paniyaram',
];
const SOUTH_INDIAN_CATEGORY_KEYWORDS = [
  'morning tiffin', 'morning_tiffin', 'tiffin', 'south indian',
  'south_indian', 'southindian',
];

// North-Indian / heavy-meal keywords
const NORTH_INDIAN_ITEM_KEYWORDS = [
  'biryani', 'biriyani', 'pulao', 'pulav', 'parotta', 'paratha',
  'fried rice', 'meals', 'curry', 'korma', 'masala', 'paneer',
  'dal makhani', 'naan', 'roti', 'thali', 'kofta',
];
const NORTH_INDIAN_CATEGORY_KEYWORDS = [
  'north indian', 'north_indian', 'northindian', 'biryani',
  'main course', 'main_course', 'meals',
];

/**
 * detectCondimentContext
 *
 * Inspects an array of order/cart items and returns a string tag indicating
 * which condiment nudge applies:
 *   'south_indian' → mention Sambar
 *   'north_indian' → mention Raita
 *   'default'      → generic extra sides prompt
 *
 * Accepts either the raw `productItems` array straight from a WhatsApp catalog
 * order payload OR a resolved `order_items` array from the DB — both shapes are
 * handled through optional-chaining so a missing field never throws.
 *
 * @param {Array}  items  - Array of product/order items (may be undefined/null)
 * @returns {'south_indian'|'north_indian'|'default'}
 */
function detectCondimentContext(items) {
  // Safely guard against undefined or non-array input
  if (!Array.isArray(items) || items.length === 0) return 'default';

  let hasSouthIndian = false;
  let hasNorthIndian = false;

  for (const item of items) {
    // Support both raw catalog payloads and DB-resolved shapes:
    //   productItem  → { product_retailer_id, item_name? }
    //   order_item   → { menu_item: { name, category } }
    //   plain object → { name, category }
    const rawName     = (item?.menu_item?.name ?? item?.item_name ?? item?.name ?? '').toLowerCase();
    const rawCategory = (item?.menu_item?.category ?? item?.category ?? '').toLowerCase();

    // South Indian check — match on name first, then category label
    const matchesSouthName     = SOUTH_INDIAN_ITEM_KEYWORDS.some(kw => rawName.includes(kw));
    const matchesSouthCategory = SOUTH_INDIAN_CATEGORY_KEYWORDS.some(kw => rawCategory.includes(kw));
    if (matchesSouthName || matchesSouthCategory) hasSouthIndian = true;

    // North Indian / Biryani / Meals check
    const matchesNorthName     = NORTH_INDIAN_ITEM_KEYWORDS.some(kw => rawName.includes(kw));
    const matchesNorthCategory = NORTH_INDIAN_CATEGORY_KEYWORDS.some(kw => rawCategory.includes(kw));
    if (matchesNorthName || matchesNorthCategory) hasNorthIndian = true;
  }

  // When both contexts appear in the same order (e.g., a family ordering
  // both Idli and Biryani), prefer the South Indian nudge because Sambar
  // is the more universal accompaniment risk to miss.
  if (hasSouthIndian) return 'south_indian';
  if (hasNorthIndian) return 'north_indian';
  return 'default';
}

/**
 * buildSpecialNotesPrompt
 *
 * Constructs the WhatsApp text that asks the customer for special notes.
 * The condiment hint is woven naturally into the copy so it reads as a
 * helpful suggestion rather than an upsell.
 *
 * @param {string} context - Output of detectCondimentContext()
 * @param {string} customerName - First name for personalisation (optional)
 * @returns {string} Ready-to-send WhatsApp message body
 */
function buildSpecialNotesPrompt(context, customerName = 'there') {
  const greeting = `Hi ${customerName}! 😊\n\n`;
  const closer   = `\n\nOr reply *"No notes"* / *"Skip"* to confirm as-is.`;

  switch (context) {
    case 'south_indian':
      return (
        greeting +
        `📝 *Any special requirements for your order?*\n\n` +
        `For example:\n` +
        `• Extra *Sambar* on the side 🍲\n` +
        `• Less spice / more spice\n` +
        `• Allergy or dietary notes\n` +
        `• Specific cooking instructions` +
        closer
      );

    case 'north_indian':
      return (
        greeting +
        `📝 *Any special requirements for your order?*\n\n` +
        `For example:\n` +
        `• Extra *Raita* on the side 🥣\n` +
        `• Less spice / extra gravy\n` +
        `• Allergy or dietary notes\n` +
        `• Specific cooking instructions` +
        closer
      );

    default:
      return (
        greeting +
        `📝 *Any special requirements for your order?*\n\n` +
        `For example:\n` +
        `• Extra side portions\n` +
        `• Spice adjustments\n` +
        `• Allergy or dietary notes\n` +
        `• Specific cooking instructions` +
        closer
      );
  }
}

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
// REQ 3 — handleFeedbackReply
// ============================================================================
//
// Called from src/routes/webhook.js when an inbound WhatsApp message matches
// an open feedback_pending record for that phone + restaurant.
//
// Flow:
//   1. Look up the most recent unsettled feedback_pending row for this phone
//   2. Parse a numeric 1-5 rating from the reply text (handles digit or star glyphs)
//   3. Persist the text + rating to the DB row
//   4. Send a personalised thank-you to the customer
//   5. Dispatch a manager escalation alert to MANAGER_WHATSAPP_NUMBER
//      — The alert explicitly includes the rating stars, score/5, table details,
//        customer name, and verbatim note text for QC monitoring
//
// @param  {string}  customerPhone  - Raw phone from the WA webhook
// @param  {string}  message        - Full text body of the inbound message
// @param  {string}  restaurantId   - Resolved from phone_number_id
// @returns {boolean} true if the message was handled as a feedback reply
// ============================================================================

async function handleFeedbackReply(customerPhone, message, restaurantId) {
  try {
    const phone = String(customerPhone).replace(/\D/g, '');

    // Find the most recent feedback record that has been SENT but not yet replied
    const { data: record } = await supabaseAdmin
      .from('feedback_pending')
      .select('*')
      .eq('customer_phone', phone)
      .eq('restaurant_id', restaurantId)
      .eq('feedback_sent', true)       // Invitation already dispatched
      .eq('manager_notified', false)   // Not yet processed this reply
      .order('freed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!record) return false; // This is not a feedback reply — let normal flow handle it

    const text      = (message || '').trim();

    // Extract numeric rating: plain digit (1-5) or star glyphs (⭐ / ★)
    const digitMatch = text.match(/\b([1-5])\b/);
    const starMatch  = text.match(/([⭐★]+)/);
    let rating = null;
    if (digitMatch) {
      rating = parseInt(digitMatch[1], 10);
    } else if (starMatch) {
      rating = Math.min((starMatch[1].match(/[⭐★]/g) || []).length, 5) || null;
    }

    // ── Step 1: Persist the customer's reply ──────────────────────────────────
    await supabaseAdmin
      .from('feedback_pending')
      .update({
        feedback_text:        text,
        feedback_rating:      rating,
        feedback_received_at: new Date().toISOString(),
        manager_notified:     true, // Mark as fully processed
      })
      .eq('id', record.id);

    // ── Step 2: Thank-you message back to the customer ─────────────────────────
    const thankYou = rating && rating >= 4
      ? `🙏 Thank you for the *${rating}⭐* rating, ${record.customer_name}!\n\nWe're so glad you enjoyed your visit. See you again soon! 😊`
      : `🙏 Thank you for your honest feedback, ${record.customer_name}!\n\nWe'll use it to make things better. Hope to see you again! 😊`;

    await sendWhatsAppMessage(customerPhone, thankYou);

    // ── Step 3: Manager escalation alert ──────────────────────────────────────
    //
    // Always send regardless of rating — the manager needs to see all feedback,
    // not just negative scores, for accurate QC monitoring.
    //
    if (process.env.MANAGER_WHATSAPP_NUMBER) {
      const starBar    = rating ? '⭐'.repeat(rating) + ` (${rating}/5)` : 'No rating given';
      const tableLabel = record.table_number ? `Table ${record.table_number}` : 'Unknown table';
      const tokenLabel = record.token_number || '—';
      const noteText   = text || '(no text provided)';

      // High-priority flag for low scores so the manager can act quickly
      const urgencyFlag = rating && rating <= 2
        ? '🚨 *LOW SCORE — Immediate follow-up recommended*\n'
        : '';

      await sendWhatsAppMessage(
        process.env.MANAGER_WHATSAPP_NUMBER,
        `📣 *Customer Feedback Alert*\n` +
        `────────────────────\n` +
        `${urgencyFlag}` +
        `Customer: *${record.customer_name}*\n` +
        `Phone:    +${phone}\n` +
        `Token:    ${tokenLabel}\n` +
        `Table:    ${tableLabel}\n` +
        `Rating:   ${starBar}\n` +
        `────────────────────\n` +
        `*Notes:*\n${noteText}\n` +
        `────────────────────\n` +
        `Received: ${new Date().toISOString()}`
      );
    }

    return true; // Consumed as a feedback reply
  } catch (err) {
    console.error('[feedback-reply] Error:', err.message);
    return false; // Let the caller decide what to do with the message
  }
}

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

/**
 * validateReferralCode
 *
 * Validates a referral code entered by a first-time customer.
 * Guards:
 *   1. Customer must have zero prior COMPLETED orders (is_first_order check).
 *   2. Code must exist in referral_codes, be active, and not exceed max_uses.
 *   3. Customer must not have already applied a referral code.
 *
 * Side-effects on success:
 *   - Inserts a `referral_uses` row linking referrer → referee.
 *   - Writes pending_referral_discount to the customer row so checkout
 *     can deduct it when the order is finalised.
 *   - Sends a WhatsApp confirmation to the referee.
 *   - Sends a WhatsApp nudge to the referrer so they know their code was used.
 *
 * @param {string} customerPhone  - Phone of the person entering the code
 * @param {string} code           - The referral code string
 * @param {string} restaurantId
 * @returns {boolean}  true if handled as a referral validation attempt
 */
async function validateReferralCode(customerPhone, code, restaurantId) {
  try {
    const cleanPhone = String(customerPhone).replace(/\D/g, '');

    // ── Guard 1: only first-time customers can redeem a referral code ─────────
    const { count: priorOrders } = await supabaseAdmin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('customer_phone', cleanPhone)
      .eq('status', 'completed');

    if ((priorOrders ?? 0) > 0) {
      await sendWhatsAppMessage(
        customerPhone,
        `🎁 Referral codes are only for first-time orders!\n\n` +
        `Welcome back — we hope you enjoy your meal. 😊`
      );
      return true; // Consumed — don't forward to Python
    }

    // ── Guard 2: check if this customer already redeemed a code ──────────────
    const { data: existingUse } = await supabaseAdmin
      .from('referral_uses')
      .select('id')
      .eq('referee_phone', cleanPhone)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();

    if (existingUse) {
      await sendWhatsAppMessage(
        customerPhone,
        `🎁 You've already applied a referral code to your account.\n\n` +
        `The discount will be applied automatically at checkout. 😊`
      );
      return true;
    }

    // ── Guard 3: look up the referral code ────────────────────────────────────
    const upperCode = String(code).toUpperCase().trim();
    const { data: referralRecord } = await supabaseAdmin
      .from('referral_codes')
      .select('id, owner_phone, referee_discount, referrer_reward, max_uses, use_count, expires_at, is_active')
      .eq('code', upperCode)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();

    if (!referralRecord || !referralRecord.is_active) {
      await sendWhatsAppMessage(
        customerPhone,
        `❌ *"${upperCode}"* is not a valid referral code.\n\n` +
        `Please check the code and try again, or place your order without a code.`
      );
      return true;
    }

    // Guard: max usage cap
    if (referralRecord.max_uses && referralRecord.use_count >= referralRecord.max_uses) {
      await sendWhatsAppMessage(
        customerPhone,
        `😔 Referral code *"${upperCode}"* has already reached its usage limit.\n\n` +
        `Place your order and enjoy the menu! 🍽️`
      );
      return true;
    }

    // Guard: expiry
    if (referralRecord.expires_at && new Date(referralRecord.expires_at) < new Date()) {
      await sendWhatsAppMessage(
        customerPhone,
        `😔 Referral code *"${upperCode}"* has expired.\n\n` +
        `Place your order and enjoy the menu! 🍽️`
      );
      return true;
    }

    // ── Apply: create referral_uses record ────────────────────────────────────
    const { error: useErr } = await supabaseAdmin
      .from('referral_uses')
      .insert({
        restaurant_id:    restaurantId,
        referral_code_id: referralRecord.id,
        referrer_phone:   referralRecord.owner_phone,
        referee_phone:    cleanPhone,
        referee_discount: referralRecord.referee_discount,
        referrer_reward:  referralRecord.referrer_reward,
        status:           'pending',   // Moves to 'rewarded' after first order completes
        applied_at:       new Date().toISOString(),
      });

    if (useErr) throw useErr;

    // Increment use_count on the code
    await supabaseAdmin
      .from('referral_codes')
      .update({ use_count: (referralRecord.use_count ?? 0) + 1 })
      .eq('id', referralRecord.id);

    // ── Confirm to referee ────────────────────────────────────────────────────
    await sendWhatsAppMessage(
      customerPhone,
      `🎉 *Referral code applied!*\n\n` +
      `You'll get *${referralRecord.referee_discount}* off your first order.\n\n` +
      `Your discount will be deducted automatically at checkout. Enjoy! 😊`
    );

    // ── Notify referrer that their code was just used ─────────────────────────
    if (referralRecord.owner_phone) {
      sendWhatsAppMessage(
        referralRecord.owner_phone,
        `🎁 *Great news!* Someone just used your referral code *${upperCode}*!\n\n` +
        `You'll receive *${referralRecord.referrer_reward}* once they complete their first order. 🙌`
      ).catch(e => console.error('[referral] Referrer notify failed:', e.message));
    }

    console.log(`[referral] ✅ Code ${upperCode} applied for ${cleanPhone}`);
    return true;

  } catch (err) {
    console.error('[referral-validate] Error:', err.message);
    return false;
  }
}

/**
 * generateReferralSharePrompt
 *
 * Sends the post-order WhatsApp share prompt to the customer.
 * Pulls the customer's unique referral code from `referral_codes`.
 * If the customer doesn't have a code yet, generates one on the fly.
 *
 * Non-fatal — a failure here must never surface to the order flow.
 *
 * @param {string} customerPhone
 * @param {string} restaurantId
 * @param {string} customerName
 */
async function generateReferralSharePrompt(customerPhone, restaurantId, customerName = 'there') {
  try {
    const cleanPhone = String(customerPhone).replace(/\D/g, '');

    // Fetch or create the customer's referral code
    let { data: codeRecord } = await supabaseAdmin
      .from('referral_codes')
      .select('code, referee_discount, referrer_reward')
      .eq('owner_phone', cleanPhone)
      .eq('restaurant_id', restaurantId)
      .eq('is_active', true)
      .maybeSingle();

    if (!codeRecord) {
      // Auto-generate a unique 6-char alphanumeric code
      const newCode = cleanPhone.slice(-4).toUpperCase() +
        Math.random().toString(36).substring(2, 4).toUpperCase();

      const { data: created, error: createErr } = await supabaseAdmin
        .from('referral_codes')
        .insert({
          restaurant_id:    restaurantId,
          owner_phone:      cleanPhone,
          code:             newCode,
          referee_discount: process.env.DEFAULT_REFEREE_DISCOUNT  || '₹50',
          referrer_reward:  process.env.DEFAULT_REFERRER_REWARD   || '₹30',
          is_active:        true,
          use_count:        0,
          created_at:       new Date().toISOString(),
        })
        .select('code, referee_discount, referrer_reward')
        .single();

      if (createErr) throw createErr;
      codeRecord = created;
    }

    const firstName = (customerName || 'there').split(' ')[0];

    await sendWhatsAppMessage(
      customerPhone,
      `Loved your meal, ${firstName}? 🎁 *Share the food love!*\n\n` +
      `Pass your unique code *${codeRecord.code}* to a friend.\n\n` +
      `They get *${codeRecord.referee_discount}* off their first order, and you get ` +
      `*${codeRecord.referrer_reward}* credited to your account when they order!\n\n` +
      `Tap to copy code: \`${codeRecord.code}\``
    );

    console.log(`[referral] 📤 Share prompt sent to ${cleanPhone} (code: ${codeRecord.code})`);

  } catch (err) {
    // Entirely non-fatal — order is complete, referral prompt is optional
    console.error('[referral-share] Failed (non-fatal):', err.message);
  }
}

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
// REQ 1 — handleWhatsAppOrder (enhanced with Sambar/Raita nudge)
// ============================================================================
//
// This replaces the original handleWhatsAppOrder that lived in
// src/routes/webhook.js.  Moving it here keeps all business logic in
// server.js and gives it access to detectCondimentContext() /
// buildSpecialNotesPrompt() without introducing a circular require.
//
// Changes vs baseline:
//   • After creating the order and KDS items, resolve the full item names
//     from the kdsInserts array (which now carries item_name).
//   • Run detectCondimentContext() against those items.
//   • Send buildSpecialNotesPrompt() as the follow-up message to the customer.
//   • Upsert conversation_states with current_state='awaiting_special_notes'
//     and special_notes_asked_at=epoch so REQ 2 monitor picks it up if idle.
// ============================================================================

async function handleWhatsAppOrder(message, metadata) {
  const customerPhone = message.from;
  const productItems  = message.order?.product_items ?? [];

  if (productItems.length === 0) {
    console.warn('[WA Order] Empty product_items — skipping');
    return;
  }

  // ── Resolve restaurant from phone_number_id ────────────────────────────────
  let restaurantId = process.env.DEFAULT_RESTAURANT_ID || null;
  if (metadata?.phone_number_id) {
    const { data: restaurant } = await supabaseAdmin
      .from('restaurants').select('id')
      .eq('whatsapp_phone_number_id', metadata.phone_number_id)
      .eq('is_active', true).single();
    if (restaurant) restaurantId = restaurant.id;
  }
  if (!restaurantId) { console.error('[WA Order] Could not resolve restaurant'); return; }

  // ── Check for feedback reply before treating this as a new order ───────────
  const wasFeedback = await handleFeedbackReply(
    customerPhone,
    message.text?.body || '',
    restaurantId
  );
  if (wasFeedback) return;

  const normalizedPhone = String(customerPhone).replace(/\D/g, '');
  const { data: token } = await supabaseAdmin
    .from('walk_in_tokens').select('*')
    .eq('restaurant_id', restaurantId).eq('phone', normalizedPhone).eq('status', 'seated')
    .order('seated_at', { ascending: false }).limit(1).maybeSingle();

  if (!token) {
    console.warn(`[WA Order] No seated token for phone ${normalizedPhone}`);
    await sendWhatsAppMessage(
      customerPhone,
      `⚠️ We couldn't find your table assignment.\nPlease ask a staff member for help.`
    );
    return;
  }

  // ── Create the order header ────────────────────────────────────────────────
  const orderNumber = `ORD-WA-${Date.now()}`;
  const { data: orderData, error: orderError } = await supabaseAdmin
    .from('orders')
    .insert({
      restaurant_id: restaurantId,
      table_id:      token.table_id,
      order_number:  orderNumber,
      status:        'pending',
      source:        'whatsapp',
    })
    .select().single();
  if (orderError) { console.error('[WA Order] Failed to create order:', orderError.message); return; }

  // ── Insert order items + build KDS batch ──────────────────────────────────
  let subtotal = 0;
  const kdsInserts = [], skippedOos = [];

  for (const item of productItems) {
    const { data: menuItem } = await supabaseAdmin
      .from('menu_items')
      .select('id, name, price, is_stocked, is_available, category')
      .eq('restaurant_id', restaurantId)
      .eq('retailer_id', item.product_retailer_id)
      .maybeSingle();

    if (!menuItem) {
      console.warn(`[WA Order] No menu item for retailer_id: ${item.product_retailer_id}`);
      continue;
    }
    if (!menuItem.is_stocked || !menuItem.is_available) {
      skippedOos.push(menuItem.name);
      continue;
    }

    subtotal += menuItem.price * item.quantity;
    const { data: orderItem, error: itemError } = await supabaseAdmin
      .from('order_items')
      .insert({
        order_id:    orderData.id,
        menu_item_id: menuItem.id,
        quantity:    item.quantity,
        unit_price:  menuItem.price,
      })
      .select().single();
    if (itemError) { console.error('[WA Order] order_item insert failed:', itemError.message); continue; }

    kdsInserts.push({
      restaurant_id: restaurantId,
      order_item_id: orderItem.id,
      status:        'pending',
      priority:      'normal',
      item_name:     menuItem.name,
      // Store category on the KDS item so REQ 1 detection can use it
      // without a second DB round-trip
      item_category: menuItem.category || '',
    });
  }

  // ── Flush KDS batch ────────────────────────────────────────────────────────
  if (kdsInserts.length > 0) {
    const { error: kdsError } = await supabaseAdmin.from('kds_items').insert(kdsInserts);
    if (kdsError) console.error('[WA Order] KDS insert failed:', kdsError.message);
  }

  // ── Finalise order totals ─────────────────────────────────────────────────
  const tax = subtotal * 0.1, total = subtotal + tax;
  await supabaseAdmin.from('orders').update({ subtotal, tax, total_amount: total }).eq('id', orderData.id);

  // ── Broadcast to dashboard WebSocket ──────────────────────────────────────
  broadcastToRestaurant(restaurantId, {
    type:         'ORDER_NEW',
    order_id:     orderData.id,
    order_number: orderNumber,
    table_number: token.table_number,
    source:       'whatsapp',
    item_count:   kdsInserts.length,
    timestamp:    new Date().toISOString(),
  });

  // ── Manager notification ──────────────────────────────────────────────────
  if (process.env.MANAGER_WHATSAPP_NUMBER) {
    const itemLines = productItems.map(i => `• ${i.quantity}x ${i.product_retailer_id}`).join('\n');
    await sendWhatsAppMessage(
      process.env.MANAGER_WHATSAPP_NUMBER,
      `🍽️ *New WhatsApp Order*\nOrder: *${orderNumber}*\nTable: *${token.table_number}*\nCustomer: ${token.name}\n\n${itemLines}\n\nTotal: ₹${total.toFixed(2)}`
    );
  }

  // ── Order-received confirmation to customer ───────────────────────────────
  const oosWarning = skippedOos.length > 0
    ? `\n\n⚠️ *Out of stock:*\n${skippedOos.map(n => `• ${n}`).join('\n')}`
    : '';
  await sendWhatsAppMessage(
    customerPhone,
    `✅ *Order received!*\n\nOrder: *${orderNumber}*\nTable: *Table ${token.table_number}*\nItems: ${kdsInserts.length}${oosWarning}\n\nWe're preparing your food now! 🍳`
  );

  // ── REQ 1: Context-aware condiment nudge ──────────────────────────────────
  //
  // Build a normalised item list from kdsInserts (which carries both
  // item_name and item_category populated above) and run the detector.
  // The prompt is sent as a follow-up message immediately after the
  // order-received confirmation so the UX reads as:
  //   1. "✅ Order received!"
  //   2. "📝 Any special notes? (e.g., extra Sambar)"
  //
  // We also upsert the conversation_states row so REQ 2's monitor can
  // detect the idle session and auto-confirm after 2 minutes.
  // ──────────────────────────────────────────────────────────────────────────

  if (kdsInserts.length > 0) {
    try {
      // Shape kdsInserts into the format detectCondimentContext() expects:
      // [{ name: '...', category: '...' }, ...]
      const itemsForDetection = kdsInserts.map(k => ({
        name:     k.item_name     || '',
        category: k.item_category || '',
      }));

      const condimentContext  = detectCondimentContext(itemsForDetection);
      const customerFirstName = (token.name || 'there').split(' ')[0];
      const notesPrompt       = buildSpecialNotesPrompt(condimentContext, customerFirstName);

      // Send the context-aware notes prompt
      await sendWhatsAppMessage(customerPhone, notesPrompt);

      // Stamp the conversation_states row so REQ 2's monitor can detect
      // this session as idle if the customer doesn't reply within 2 minutes.
      // conversation_states is the canonical state store for the Python ADK
      // agent — keyed by (restaurant_id, customer_phone).
      // We upsert so it works whether or not a prior conversation row exists.
      try {
        const epochNow = Math.floor(Date.now() / 1000); // Unix epoch float matches Python
        const sessionKey = `${restaurantId}:${normalizedPhone}`;
        await supabaseAdmin
          .from('conversation_states')
          .upsert({
            restaurant_id:  restaurantId,
            customer_phone: normalizedPhone,
            adk_session_id: sessionKey,
            current_state:  'awaiting_special_notes',
            context: {
              booking_step:             'awaiting_special_notes',
              special_notes_asked_at:   epochNow,         // float epoch — matches Python time.time()
              notes_order_id:           orderData.id,
              customer_name:            token.name || 'Guest',
              token_number:             token.id,
              // booking_id: not available at this point in the catalog-order flow;
              // the Python agent will have set it if this is a hybrid session.
            },
            updated_at: new Date().toISOString(),
          }, {
            onConflict: 'restaurant_id,customer_phone',
            ignoreDuplicates: false,
          });
      } catch (stampErr) {
        // Non-fatal — monitor will simply not find this session; order is safe
        console.warn('[WA Order] conversation_states stamp failed:', stampErr.message);
      }

      console.log(
        `[WA Order] 📝 Condiment nudge sent (context: ${condimentContext}) ` +
        `for order ${orderNumber}`
      );

    } catch (nudgeErr) {
      // Non-fatal — order is already placed; a nudge failure is just cosmetic
      console.error('[WA Order] Condiment nudge failed (non-fatal):', nudgeErr.message);
    }
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  try {
    await supabaseAdmin.from('audit_logs').insert({
      restaurant_id: restaurantId,
      action:        'WhatsApp order created',
      details: {
        order_id:     orderData.id,
        order_number: orderNumber,
        phone:        normalizedPhone,
        item_count:   kdsInserts.length,
      },
    });
  } catch (_) {}

  // ── REQ 7: Auto-generate GST invoice for this order ───────────────────────
  // Fire-and-forget — invoice generation must never block or fail the order flow
  try {
    const { data: restaurant } = await supabaseAdmin
      .from('restaurants')
      .select('id, name, gstin, brand_id')
      .eq('id', restaurantId)
      .maybeSingle();

    // Fetch the order_items we just created so buildInvoicePayload has line items
    const { data: orderWithItems } = await supabaseAdmin
      .from('orders')
      .select('*, order_items(quantity, unit_price, menu_item:menu_item_id(name, category))')
      .eq('id', orderData.id)
      .single();

    if (orderWithItems && restaurant) {
      const invoicePayload = buildInvoicePayload(orderWithItems, restaurant, GST_RATES.default);
      await supabaseAdmin
        .from('invoices')
        .upsert({
          restaurant_id:          restaurantId,
          order_id:               orderData.id,
          payload:                invoicePayload,
          gst_rate:               GST_RATES.default,
          grand_total:            invoicePayload.financial_breakdown.grand_total,
          accounting_sync_status: 'PENDING_DAILY_ROLLUP_ZOHO_TALLY',
          generated_at:           new Date().toISOString(),
        }, { onConflict: 'order_id', ignoreDuplicates: false });
      console.log(`[WA Order] 🧾 Invoice queued for order ${orderNumber}`);
    }
  } catch (invoiceErr) {
    console.error('[WA Order] Invoice generation failed (non-fatal):', invoiceErr.message);
  }

  // ── REQ 4: Post-order referral share prompt ────────────────────────────────
  // Sent last so it appears after the order-confirmation flow completes.
  // Non-fatal — a referral prompt failure never affects the order.
  generateReferralSharePrompt(customerPhone, restaurantId, token.name)
    .catch(e => console.error('[WA Order] Referral share prompt failed:', e.message));
}

// Named exports for src/routes/webhook.js — merged into the bottom export object.

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
      supabaseAdmin.from('bookings').select('id', { count: 'exact', head: true }).eq('restaurant_id', restaurantId).eq('status', 'cancelled').gte('created_at', start).lte('created_at', end),
      supabaseAdmin.from('bookings').select('id', { count: 'exact', head: true }).eq('restaurant_id', restaurantId).gte('created_at', start).lte('created_at', end),
    ]);

    const orderCancels   = cancelRes.data ?? [];
    const totalOrders    = totalRes.count ?? 0;
    const orderRevLost   = orderCancels.reduce((s, o) => s + (o.total_amount ?? 0), 0);
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

// ============================================================================
// START SERVER
// ============================================================================

async function runStartupSync() {
  console.log('🚀 Running startup checks...');
  try {
    const { data: restaurants, error } = await supabaseAdmin
      .from('restaurants')
      .select('id, name')
      .eq('is_active', true);

    if (error) throw error;

    if (!restaurants || restaurants.length === 0) {
      console.error('🚨 STARTUP WARNING: No active restaurants found in DB.');
      console.error('   Menu uploads and catalog sync will fail until a restaurant row exists.');
      console.error('   Run the seed SQL or insert a row into the restaurants table.');
    } else {
      console.log(`✅ Found ${restaurants.length} active restaurant(s): ${restaurants.map(r => r.name).join(', ')}`);
      for (const r of restaurants) {
        await syncCatalogFromMeta(r.id);
      }
    }
  } catch (err) {
    console.error('Startup check error:', err);
  }
}

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`\n🚀 Autom8 Backend running on port ${PORT}`);
  console.log(`📍 Region: ${process.env.REGION || 'IN'}`);
  console.log(`🗄️  Database: ${process.env.SUPABASE_URL}\n`);
  startSlotScheduler();   // Starts slot rotation + feedback scheduler + notes timeout monitor
  runStartupSync();
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received — closing server');
  server.close(() => console.log('HTTP server closed'));
});

// Single export object — includes app/wss/WebSocket helpers AND the business-logic
// functions imported by src/routes/webhook.js.
module.exports = {
  app,
  wss,
  broadcastToRestaurant,
  handleWhatsAppOrder,
  handleFeedbackReply,
  queueFeedbackForTable,
  validateReferralCode,
};
