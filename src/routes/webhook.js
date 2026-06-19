// src/routes/webhook.js
// Handles: WhatsApp webhook verification + message routing
//
// Message routing priority (text/button/interactive messages):
//   1. handleFeedbackReply()    — consumes a feedback star/rating reply (REQ 3)
//   2. validateReferralCode()   — consumes a 6-char alphanumeric referral code (REQ 4)
//   3. forwardToChatService()   — all other messages proxied to Python ADK agent
//
// Catalog order messages (type === 'order'):
//   → handleWhatsAppOrder() in waHandlers.js
//
// MULTI-OUTLET ROUTING:
//   Restaurant is resolved from metadata.phone_number_id via restaurant_integrations
//   (not restaurants.whatsapp_phone_number_id which does not exist in the schema).
//   A 5-minute in-memory cache (resolveRestaurantByPhone) avoids a DB hit per message.

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin }         = require('../config/supabase');
const { sendWhatsAppMessage }   = require('../helpers/whatsapp');
const { broadcastToRestaurant } = require('../websocket');
const { resolveRestaurantByPhone } = require('../helpers/resolveRestaurant');

const { handleWhatsAppOrder, handleFeedbackReply, validateReferralCode }
  = require('../handlers/waHandlers');
const { isWhatsAppAutoReply } = require('../helpers/whatsappAutoReply');
const { writeAuditLog } = require('../helpers/auditLog');

const CHAT_SERVICE_URL  = process.env.CHAT_SERVICE_URL || 'http://localhost:8001';
const OUR_WHATSAPP_PHONE = process.env.WHATSAPP_PHONE_NUMBER || '';
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

          const messageText = message.text?.body
            || message.button?.text
            || message.interactive?.list_reply?.title
            || message.interactive?.button_reply?.title
            || '';

          if (isWhatsAppAutoReply(message, messageText, OUR_WHATSAPP_PHONE)) {
            console.info(
              `[WA Webhook] Ignoring auto-reply from ${message.from}: ${messageText.slice(0, 80)}`
            );
            continue;
          }

          // ── Resolve restaurant_id from phone_number_id ───────────────────
          // Uses restaurant_integrations table via cached helper.
          // Falls back to DEFAULT_RESTAURANT_ID env var for dev/staging.
          let restaurantId = null;
          if (metadata?.phone_number_id) {
            restaurantId = await resolveRestaurantByPhone(metadata.phone_number_id)
              .catch(err => {
                console.warn('[WA Webhook] resolveRestaurantByPhone error:', err.message);
                return null;
              });
          }
          if (!restaurantId) {
            restaurantId = process.env.DEFAULT_RESTAURANT_ID ?? null;
            if (restaurantId) {
              console.warn(`[WA Webhook] phone_number_id not found in integrations — using DEFAULT_RESTAURANT_ID`);
            }
          }

          if (message.type === 'order') {
            await handleWhatsAppOrder(message, metadata, restaurantId).catch(err =>
              console.error('[WA Webhook] handleWhatsAppOrder failed:', err.message)
            );

          } else if (message.type === 'text' || message.type === 'button' || message.type === 'interactive') {
            // ── Priority 1: Feedback reply ─────────────────────────────────
            const wasFeedback = restaurantId
              ? await handleFeedbackReply(message.from, message, restaurantId).catch(err => {
                  console.error('[WA Webhook] handleFeedbackReply failed:', err.message);
                  return { consumed: false, completed: false };
                })
              : { consumed: false, completed: false };

            if (wasFeedback.consumed) continue;

            // ── Priority 2: Referral code ──────────────────────────────────
            const referralMatch = messageText.match(REFERRAL_CODE_REGEX);
            if (referralMatch && restaurantId) {
              const wasReferral = await validateReferralCode(
                message.from, referralMatch[1], restaurantId
              ).catch(err => {
                console.error('[WA Webhook] validateReferralCode failed:', err.message);
                return false;
              });
              if (wasReferral) continue;
            }

            // ── Priority 3: Forward to Python chat service ─────────────────
            await forwardToChatService(message, metadata, value).catch(err =>
              console.error('[WA Webhook] forwardToChatService failed:', err.message)
            );

          } else {
            await forwardToChatService(message, metadata, value).catch(err =>
              console.error('[WA Webhook] forwardToChatService failed:', err.message)
            );
          }

          // Audit log — best-effort
          void writeAuditLog({
            action:        'WhatsApp message received',
            restaurant_id: restaurantId,
            details: {
              type:            message.type,
              from:            message.from,
              phone_number_id: metadata?.phone_number_id,
              message_id:      message.id,
            },
          });
        }
      }
    }
  } catch (err) {
    console.error('[WA Webhook] Top-level error:', err.message);
  }
});

// ── Forward to Python chat service ───────────────────────────────────────────
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
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`[webhook-proxy] Python returned ${response.status}: ${body.slice(0, 200)}`);
    } else {
      console.log(`[webhook-proxy] ✅ Forwarded ${message.type} from ${message.from}`);
    }
  } catch (err) {
    console.error(`[webhook-proxy] Failed to reach chat service: ${err.message}`);
  }
}

module.exports = router;
