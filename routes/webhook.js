// src/routes/webhook.js
// Handles: WhatsApp webhook verification + message routing
//
// TWO types of WhatsApp messages arrive here:
//   1. order  → handled directly in Node (creates POS order + KDS items)
//   2. text/interactive (booking flow, conversation) → proxied to Python chat
//      service running on localhost:8001
//
// This is the key file that bridges the merged repo:
//   Node owns the POS side (orders, KDS)
//   Python owns the conversation side (bookings, agents, ADK)

const express = require('express');
const router  = express.Router();
const { supabaseAdmin }         = require('../config/supabase');
const { sendWhatsAppMessage }   = require('../whatsapp');
const { broadcastToRestaurant } = require('../websocket');
const { handleFeedbackReply }   = require('../feedback');

// Internal Python chat service URL — same Railway deployment, different process
const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || 'http://localhost:8001';

// ── GET /api/whatsapp/webhook — Meta verification ────────────────────────────
router.get('/webhook', (req, res) => {
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

// ── POST /api/whatsapp/webhook — incoming messages ───────────────────────────
router.post('/webhook', async (req, res) => {
  // Respond immediately — Meta requires < 5s acknowledgement
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
          console.log(`[WA Webhook] type=${message.type} from=${message.from}`);

          if (message.type === 'order') {
            // WhatsApp catalog orders → handled by Node (creates POS order + KDS)
            await handleWhatsAppOrder(message, metadata).catch(err =>
              console.error('[WA Webhook] handleWhatsAppOrder failed:', err.message)
            );
          } else {
            // All other message types (text, interactive, button, etc.)
            // → proxy to Python chat service for ADK/booking agent handling
            await forwardToChatService(message, metadata, value).catch(err =>
              console.error('[WA Webhook] forwardToChatService failed:', err.message)
            );
          }

          // Audit log
          try {
            await supabaseAdmin.from('audit_logs').insert({
              action: 'WhatsApp message received',
              details: { type: message.type, from: message.from, phone_number_id: metadata?.phone_number_id, message_id: message.id },
            });
          } catch (_) {}
        }
      }
    }
  } catch (err) {
    console.error('[WA Webhook] Top-level error:', err.message);
  }
});

// ── Forward non-order messages to Python chat service ───────────────────────
async function forwardToChatService(message, metadata, value) {
  try {
    const response = await fetch(`${CHAT_SERVICE_URL}/webhook/botbiz`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{
          changes: [{
            field: 'messages',
            value: { ...value, messages: [message], metadata },
          }],
        }],
      }),
      signal: AbortSignal.timeout(10_000), // 10s timeout — don't block Node event loop
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`[webhook-proxy] Python returned ${response.status}: ${body.slice(0, 200)}`);
    } else {
      console.log(`[webhook-proxy] ✅ Forwarded ${message.type} from ${message.from} to chat service`);
    }
  } catch (err) {
    // Network error (Python service down, timeout etc.) — log and move on.
    // The WhatsApp ACK is already sent so Meta won't retry.
    console.error(`[webhook-proxy] Failed to reach chat service: ${err.message}`);
  }
}

// ── Handle WhatsApp catalog orders in Node ───────────────────────────────────
// (Kept in Node because it writes to POS tables: orders, order_items, kds_items)
async function handleWhatsAppOrder(message, metadata) {
  const customerPhone = message.from;
  const productItems  = message.order?.product_items ?? [];

  if (productItems.length === 0) { console.warn('[WA Order] Empty product_items — skipping'); return; }

  // Resolve restaurant from phone_number_id
  let restaurantId = process.env.DEFAULT_RESTAURANT_ID || null;
  if (metadata?.phone_number_id) {
    const { data: restaurant } = await supabaseAdmin.from('restaurants').select('id')
      .eq('whatsapp_phone_number_id', metadata.phone_number_id).eq('is_active', true).single();
    if (restaurant) restaurantId = restaurant.id;
  }
  if (!restaurantId) { console.error('[WA Order] Could not resolve restaurant'); return; }

  // Check for feedback reply first
  const wasFeedback = await handleFeedbackReply(customerPhone, message.text?.body || '', restaurantId);
  if (wasFeedback) return;

  const normalizedPhone = String(customerPhone).replace(/\D/g, '');
  const { data: token } = await supabaseAdmin.from('walk_in_tokens').select('*')
    .eq('restaurant_id', restaurantId).eq('phone', normalizedPhone).eq('status', 'seated')
    .order('seated_at', { ascending: false }).limit(1).maybeSingle();

  if (!token) {
    console.warn(`[WA Order] No seated token for phone ${normalizedPhone}`);
    await sendWhatsAppMessage(customerPhone, `⚠️ We couldn't find your table assignment.\nPlease ask a staff member for help.`);
    return;
  }

  const orderNumber = `ORD-WA-${Date.now()}`;
  const { data: orderData, error: orderError } = await supabaseAdmin.from('orders')
    .insert({ restaurant_id: restaurantId, table_id: token.table_id, order_number: orderNumber, status: 'pending', source: 'whatsapp' })
    .select().single();
  if (orderError) { console.error('[WA Order] Failed to create order:', orderError.message); return; }

  let subtotal = 0;
  const kdsInserts = [], skippedOos = [];

  for (const item of productItems) {
    const { data: menuItem } = await supabaseAdmin.from('menu_items')
      .select('id, name, price, is_stocked, is_available')
      .eq('restaurant_id', restaurantId).eq('retailer_id', item.product_retailer_id).maybeSingle();
    if (!menuItem) { console.warn(`[WA Order] No menu item for retailer_id: ${item.product_retailer_id}`); continue; }
    if (!menuItem.is_stocked || !menuItem.is_available) { skippedOos.push(menuItem.name); continue; }

    subtotal += menuItem.price * item.quantity;
    const { data: orderItem, error: itemError } = await supabaseAdmin.from('order_items')
      .insert({ order_id: orderData.id, menu_item_id: menuItem.id, quantity: item.quantity, unit_price: menuItem.price })
      .select().single();
    if (itemError) { console.error('[WA Order] order_item insert failed:', itemError.message); continue; }
    kdsInserts.push({ restaurant_id: restaurantId, order_item_id: orderItem.id, status: 'pending', priority: 'normal', item_name: menuItem.name });
  }

  if (kdsInserts.length > 0) {
    const { error: kdsError } = await supabaseAdmin.from('kds_items').insert(kdsInserts);
    if (kdsError) console.error('[WA Order] KDS insert failed:', kdsError.message);
  }

  const tax = subtotal * 0.1, total = subtotal + tax;
  await supabaseAdmin.from('orders').update({ subtotal, tax, total_amount: total }).eq('id', orderData.id);

  broadcastToRestaurant(restaurantId, { type: 'ORDER_NEW', order_id: orderData.id, order_number: orderNumber, table_number: token.table_number, source: 'whatsapp', item_count: kdsInserts.length, timestamp: new Date().toISOString() });

  if (process.env.MANAGER_WHATSAPP_NUMBER) {
    const itemLines = productItems.map(i => `• ${i.quantity}x ${i.product_retailer_id}`).join('\n');
    await sendWhatsAppMessage(process.env.MANAGER_WHATSAPP_NUMBER, `🍽️ *New WhatsApp Order*\nOrder: *${orderNumber}*\nTable: *${token.table_number}*\nCustomer: ${token.name}\n\n${itemLines}\n\nTotal: ₹${total.toFixed(2)}`);
  }

  const oosWarning = skippedOos.length > 0 ? `\n\n⚠️ *Out of stock:*\n${skippedOos.map(n => `• ${n}`).join('\n')}` : '';
  await sendWhatsAppMessage(customerPhone, `✅ *Order received!*\n\nOrder: *${orderNumber}*\nTable: *Table ${token.table_number}*\nItems: ${kdsInserts.length}${oosWarning}\n\nWe're preparing your food now! 🍳`);

  try {
    await supabaseAdmin.from('audit_logs').insert({ restaurant_id: restaurantId, action: 'WhatsApp order created', details: { order_id: orderData.id, order_number: orderNumber, phone: normalizedPhone, item_count: kdsInserts.length } });
  } catch (_) {}
}

module.exports = router;
