// src/routes/webhook.js
// Handles: WhatsApp webhook verification + message routing
//
// Message routing priority (text/button messages):
//   1. handleFeedbackReply()    — consumes a feedback star/rating reply (REQ 3)
//   2. validateReferralCode()   — consumes a 6-char alphanumeric referral code (REQ 4)
//   3. forwardToChatService()   — all other messages proxied to Python ADK agent
//
// Catalog order messages (type === 'order'):
//   → handleWhatsAppOrder() in server.js (REQ 1 nudge + REQ 4 share + REQ 7 invoice)
//
// All three business-logic helpers are imported from server.js to avoid
// duplication and to share the same supabaseAdmin client instance.

const express = require('express');
const router  = express.Router();

const { supabaseAdmin }         = require('../config/supabase');
const { sendWhatsAppMessage }   = require('../whatsapp');
const { broadcastToRestaurant } = require('../websocket');

// Import shared business-logic helpers from server.js.
// server.js registers module.exports BEFORE requiring this route file
// (routes are loaded inside the server.listen callback), so the
// circular reference is safe at runtime.

const { handleWhatsAppOrder, handleFeedbackReply, validateReferralCode } = require('../handlers/waHandlers');

// Internal Python chat service URL — same Railway deployment, different process
const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || 'http://localhost:8001';

// Referral code pattern — 6-char alphanumeric (e.g. "ABCD12", "9876XY")
// Matches when the entire message body is exactly a code (with optional whitespace)
const REFERRAL_CODE_REGEX = /^\s*([A-Z0-9]{6})\s*$/i;

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
            // WhatsApp catalog orders → Node handles (creates POS order + KDS +
            // REQ 1 condiment nudge via handleWhatsAppOrder in server.js)
            await handleWhatsAppOrder(message, metadata).catch(err =>
              console.error('[WA Webhook] handleWhatsAppOrder failed:', err.message)
            );

          } else if (message.type === 'text' || message.type === 'button') {
            // ── Resolve restaurant_id from phone_number_id ─────────────────
            let restaurantId = process.env.DEFAULT_RESTAURANT_ID || null;
            if (metadata?.phone_number_id) {
              const { data: restaurant } = await supabaseAdmin
                .from('restaurants').select('id')
                .eq('whatsapp_phone_number_id', metadata.phone_number_id)
                .eq('is_active', true).single();
              if (restaurant) restaurantId = restaurant.id;
            }

            const messageText = message.text?.body || message.button?.text || '';

            // ── Priority 1: REQ 3 — Feedback reply check ──────────────────
            // Must run before referral check: a "4" could be both a rating
            // and the start of a referral code; feedback takes precedence.
            const wasFeedback = restaurantId
              ? await handleFeedbackReply(message.from, messageText, restaurantId).catch(err => {
                  console.error('[WA Webhook] handleFeedbackReply failed:', err.message);
                  return false;
                })
              : false;

            if (wasFeedback) continue; // Consumed — skip Python proxy

            // ── Priority 2: REQ 4 — Referral code detection ───────────────
            // Only triggers when the entire message body matches the 6-char
            // alphanumeric pattern so normal conversation is never hijacked.
            const referralMatch = messageText.match(REFERRAL_CODE_REGEX);
            if (referralMatch && restaurantId) {
              const wasReferral = await validateReferralCode(
                message.from,
                referralMatch[1],
                restaurantId
              ).catch(err => {
                console.error('[WA Webhook] validateReferralCode failed:', err.message);
                return false;
              });
              if (wasReferral) continue; // Consumed — skip Python proxy
            }

            // ── Priority 3: Forward to Python chat service ─────────────────
            await forwardToChatService(message, metadata, value).catch(err =>
              console.error('[WA Webhook] forwardToChatService failed:', err.message)
            );

          } else {
            // All other message types (interactive, location, sticker, etc.)
            // → proxy to Python chat service
            await forwardToChatService(message, metadata, value).catch(err =>
              console.error('[WA Webhook] forwardToChatService failed:', err.message)
            );
          }

          // Audit log — best-effort, never blocks message processing
          try {
            await supabaseAdmin.from('audit_logs').insert({
              action:  'WhatsApp message received',
              details: {
                type:            message.type,
                from:            message.from,
                phone_number_id: metadata?.phone_number_id,
                message_id:      message.id,
              },
            });
          } catch (_) {}
        }
      }
    }
  } catch (err) {
    console.error('[WA Webhook] Top-level error:', err.message);
  }
});

// ── Forward non-order, non-feedback messages to Python chat service ──────────
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
      signal: AbortSignal.timeout(10_000), // 10-second guard — never block Node event loop
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`[webhook-proxy] Python returned ${response.status}: ${body.slice(0, 200)}`);
    } else {
      console.log(`[webhook-proxy] ✅ Forwarded ${message.type} from ${message.from} to chat service`);
    }
  } catch (err) {
    // Network error (Python service down, timeout, etc.) — log and move on.
    // The WhatsApp ACK is already sent so Meta will not retry.
    console.error(`[webhook-proxy] Failed to reach chat service: ${err.message}`);
  }
}

module.exports = router;
