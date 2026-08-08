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
const { sendWhatsAppMessage, scheduleWhatsAppReadReceipt } = require('../helpers/whatsapp');
const { broadcastToRestaurant } = require('../websocket');
const { resolveRestaurantByPhone } = require('../helpers/resolveRestaurant');
const {
  resolveSupplierByRestaurantId,
  resolveClientByPhone,
} = require('../helpers/resolveSupplier');
const { forwardToSupplyChatService } = require('../helpers/supplyChatForward');
const { isSupplyOptedIn } = require('../helpers/subscriptionPricing');

const { handleWhatsAppOrder, handleFeedbackReply, validateReferralCode }
  = require('../handlers/waHandlers');
const { isWhatsAppAutoReply } = require('../helpers/whatsappAutoReply');
const { writeAuditLog } = require('../helpers/auditLog');
const { getSession } = require('../bot/session/sessionStore');
const { handleLocationMessage } = require('../bot/handlers/locationHandler');
const {
  handleInteractiveReply,
  handleCustomAddressText,
} = require('../bot/handlers/interactiveReplyHandler');

const CHAT_SERVICE_URL  = process.env.CHAT_SERVICE_URL || 'http://localhost:8001';
const OUR_WHATSAPP_PHONE = process.env.WHATSAPP_PHONE_NUMBER || '';
const REFERRAL_CODE_REGEX = /^\s*([A-Z0-9]{6})\s*$/i;

const _supplyFlagCache = new Map(); // restaurantId → { supply_enabled, lob_type, expires_at }
const SUPPLY_FLAG_TTL_MS = 60_000;

async function loadTenantSupplyFlag(restaurantId) {
  if (!restaurantId) return null;
  const cached = _supplyFlagCache.get(restaurantId);
  if (cached && Date.now() < cached.expires_at) return cached;
  try {
    const { data, error } = await supabaseAdmin
      .from('tenants')
      .select('id, supply_enabled, lob_type')
      .eq('id', restaurantId)
      .maybeSingle();
    if (error) {
      // Column may not exist until migration — treat as not opted in
      if (/supply_enabled/i.test(error.message || '')) {
        const row = { supply_enabled: false, lob_type: null, expires_at: Date.now() + SUPPLY_FLAG_TTL_MS };
        _supplyFlagCache.set(restaurantId, row);
        return row;
      }
      console.warn('[WA Webhook] supply flag load:', error.message);
      return null;
    }
    const row = {
      supply_enabled: !!data?.supply_enabled,
      lob_type: data?.lob_type || null,
      expires_at: Date.now() + SUPPLY_FLAG_TTL_MS,
    };
    _supplyFlagCache.set(restaurantId, row);
    return row;
  } catch (err) {
    console.warn('[WA Webhook] supply flag load failed:', err.message);
    return null;
  }
}

/**
 * Dual-LOB gate: only when supply is opted in, and only for registered supply_clients.
 * Unknown senders fall through to the retail/catalog flow.
 */
async function tryRouteToSupplyIfClient(message, metadata, value, restaurantId) {
  if (!restaurantId || !message?.from) return false;
  const flag = await loadTenantSupplyFlag(restaurantId);
  if (!flag || !isSupplyOptedIn(flag)) return false;

  const supplierId = await resolveSupplierByRestaurantId(restaurantId);
  if (!supplierId) {
    console.warn(`[WA Webhook] supply_enabled but no suppliers row for ${restaurantId}`);
    return false;
  }
  const client = await resolveClientByPhone(message.from, supplierId);
  if (!client) return false;

  await forwardToSupplyChatService(message, metadata, value, supplierId, client.id);
  return true;
}

const GREETING_OR_RESET = new Set([
  'hi', 'hello', 'hey', 'hii', 'hiii', 'hai', 'namaste', 'vanakkam',
  'home', 'menu', 'main menu', 'mainmenu', 'restart', 'start over', 'startover',
  'reboot', 'new', 'begin',
]);

function isLikelyNonFeedbackText(text) {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return false;
  if (GREETING_OR_RESET.has(normalized)) return true;
  // "hi munafe" / "hi psl" — still a greeting, never a star rating
  const parts = normalized.split(/\s+/);
  if (parts.length <= 2 && GREETING_OR_RESET.has(parts[0])) return true;
  return false;
}

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
        // Additive: log account_update (Embedded Signup / WABA health) — do not route as messages
        if (change.field === 'account_update') {
          const wabaId = entry.id;
          const event  = change.value?.event;
          const reason = change.value?.reason;
          console.log(`[WA Webhook] account_update waba=${wabaId} event=${event || 'n/a'} reason=${reason || 'n/a'}`);
          writeAuditLog({
            restaurant_id: null,
            actor_id:      null,
            action:        'whatsapp.account_update',
            entity_type:   'waba',
            entity_id:     wabaId || null,
            meta:          change.value || {},
          }).catch(() => {});
          continue;
        }

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

          // Dual-LOB: registered supply buyers → supply agent (before greeting/retail).
          // Skipped entirely when supply_enabled is false.
          if (restaurantId) {
            const routedSupply = await tryRouteToSupplyIfClient(
              message, metadata, value, restaurantId,
            ).catch((err) => {
              console.error('[WA Webhook] supply dual-route failed:', err.message);
              return false;
            });
            if (routedSupply) continue;
          }

          // Delayed blue ticks + typing (~4.5s) — does not block reply pipeline.
          // Pass phone_number_id so read still works when restaurant resolve fails
          // (or Meta webhook only has PNID).
          if (message.id) {
            scheduleWhatsAppReadReceipt(message.id, restaurantId, 4500, {
              phoneNumberId: metadata?.phone_number_id || null,
            });
          } else {
            console.warn('[WA Webhook] inbound message missing id — cannot mark as read');
          }

          const session = restaurantId
            ? await getSession(restaurantId, message.from).catch(err => {
                console.warn('[WA Webhook] getSession error:', err.message);
                return null;
              })
            : null;

          // Python booking owns address capture during these steps — do not
          // intercept location / addr_* so the chat agent can reverse-geocode
          // and offer nearby address choices.
          const bookingStep = session?.context?.booking_step || null;
          const pythonOwnsAddress = bookingStep === 'awaiting_address'
            || bookingStep === 'awaiting_address_choice';

          if (message.type === 'location' && restaurantId && session && !pythonOwnsAddress) {
            const handledLocation = await handleLocationMessage(message, session).catch(err => {
              console.error('[WA Webhook] handleLocationMessage failed:', err.message);
              return false;
            });
            if (handledLocation) continue;
          }

          if (message.type === 'order') {
            await handleWhatsAppOrder(message, metadata, restaurantId).catch(err =>
              console.error('[WA Webhook] handleWhatsAppOrder failed:', err.message)
            );

          } else if (message.type === 'text' || message.type === 'button' || message.type === 'interactive') {
            if (restaurantId && session && message.type === 'interactive' && !pythonOwnsAddress) {
              const handledInteractive = await handleInteractiveReply(message, session).catch(err => {
                console.error('[WA Webhook] handleInteractiveReply failed:', err.message);
                return false;
              });
              if (handledInteractive) continue;
            }

            if (restaurantId && session && message.type === 'text' && !pythonOwnsAddress) {
              const handledCustomAddress = await handleCustomAddressText(
                message.text?.body || '',
                session,
              ).catch(err => {
                console.error('[WA Webhook] handleCustomAddressText failed:', err.message);
                return false;
              });
              if (handledCustomAddress) continue;
            }

            // ── Priority 1: Feedback reply ─────────────────────────────────
            // Skip DB look-up for greetings / Home — never feedback replies.
            const skipFeedback = isLikelyNonFeedbackText(messageText);
            let feedbackChecked = false;
            const wasFeedback = (!skipFeedback && restaurantId)
              ? await handleFeedbackReply(message.from, message, restaurantId).catch(err => {
                  console.error('[WA Webhook] handleFeedbackReply failed:', err.message);
                  return { consumed: false, completed: false };
                })
              : { consumed: false, completed: false };
            feedbackChecked = !skipFeedback && Boolean(restaurantId);

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
            // Fire-and-forget: Meta already got 200. Awaiting Python (up to 10s)
            // only blocks later messages in the same webhook batch.
            void forwardToChatService(message, metadata, value, {
              feedbackChecked,
            }).catch(err =>
              console.error('[WA Webhook] forwardToChatService failed:', err.message)
            );

          } else {
            void forwardToChatService(message, metadata, value).catch(err =>
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
async function forwardToChatService(message, metadata, value, opts = {}) {
  try {
    const response = await fetch(`${CHAT_SERVICE_URL}/webhook/botbiz`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        object: 'whatsapp_business_account',
        // Node already ran handleFeedbackReply for this message — Python must
        // not pay the sync feedback-bridge HTTP hop again.
        _autom8_feedback_checked: Boolean(opts.feedbackChecked),
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
