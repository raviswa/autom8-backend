// src/routes/supply/webhook.js
// ============================================================================
// Munafe Supply — WhatsApp webhook
//
// Meta registers ONE webhook URL per WABA account. Both incoming messages
// AND delivery status updates arrive at the same POST endpoint.
//
// Register in Meta Developer Portal:
//   Callback URL:  https://[supply-backend-domain]/api/supply/webhook/whatsapp
//   Verify token:  process.env.SUPPLY_WEBHOOK_VERIFY_TOKEN
//
// Routes:
//   GET  /whatsapp   — Meta webhook verification (hub.challenge handshake)
//   POST /whatsapp   — incoming messages + delivery status updates
//
// Incoming message flow:
//   1. Resolve supplier from metadata.phone_number_id  (suppliers table)
//   2. Resolve client from message.from               (supply_clients table)
//   3. Forward full payload to SUPPLY_CHAT_SERVICE_URL (autom8-chat supply)
//
// Status update flow:
//   1. Find wa_message_id in supply_notification_log
//   2. Update status field in place
//
// env vars:
//   SUPPLY_WEBHOOK_VERIFY_TOKEN   — must match what you register in Meta
//   SUPPLY_CHAT_SERVICE_URL        — e.g. https://chat-supply.autom8.works
//                                    or Railway internal URL for lower latency
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin }                                  = require('../../config/supabase');
const { resolveSupplierByPhone, resolveClientByPhone }   = require('../../helpers/resolveSupplier');

const SUPPLY_CHAT_URL = process.env.SUPPLY_CHAT_SERVICE_URL || 'http://localhost:8002';

// ── GET /api/supply/webhook/whatsapp — Meta webhook verification ──────────────
// Register this URL in Meta: https://[supply-backend]/api/supply/webhook/whatsapp
// Verify token env: SUPPLY_WEBHOOK_VERIFY_TOKEN

router.get('/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected  = process.env.SUPPLY_WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && expected && token === expected) {
    console.log('[supply/webhook] ✅ Webhook verified');
    return res.status(200).send(challenge);
  }

  console.warn('[supply/webhook] Verification failed — token mismatch');
  return res.status(403).json({ error: 'Forbidden' });
});

// ── POST /api/supply/webhook/whatsapp — incoming messages + status updates ────
// Meta requires a 200 response within 5s — acknowledge immediately, process async.

router.post('/whatsapp', async (req, res) => {
  // Acknowledge immediately so Meta doesn't retry
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;

        const value    = change.value;
        const metadata = value?.metadata;

        // ── Delivery status updates ──────────────────────────────────────────
        // Process first — they don't need supplier resolution
        for (const status of value?.statuses ?? []) {
          if (!status.id || !status.status) continue;

          // Meta uses 'read' for read receipts — map to 'delivered' in our log
          const logStatus = status.status === 'read' ? 'delivered' : status.status;

          supabaseAdmin
            .from('supply_notification_log')
            .update({ status: logStatus, payload: { webhook_status: status } })
            .eq('wa_message_id', status.id)
            .then(({ error }) => {
              if (error) console.warn('[supply/webhook] Status update failed:', error.message);
            });
        }

        // ── Incoming messages ────────────────────────────────────────────────
        for (const message of value?.messages ?? []) {
          console.log(`[supply/webhook] msg type=${message.type} from=${message.from}`);

          // 1. Identify which supplier this number belongs to
          let supplierId = null;
          if (metadata?.phone_number_id) {
            supplierId = await resolveSupplierByPhone(metadata.phone_number_id).catch(err => {
              console.warn('[supply/webhook] resolveSupplierByPhone error:', err.message);
              return null;
            });
          }

          if (!supplierId) {
            // No supplier found for this phone_number_id — log and skip
            // (could be a test number or misconfigured WABA)
            console.warn(
              `[supply/webhook] No supplier for phone_number_id=${metadata?.phone_number_id}. ` +
              `Message from ${message.from} dropped.`
            );
            continue;
          }

          // 2. Identify which client is messaging (best-effort — chat service can also do this)
          const client = await resolveClientByPhone(message.from, supplierId).catch(() => null);

          // 3. Forward to supply chat service with resolved context injected
          await forwardToSupplyChatService(message, metadata, value, supplierId, client?.id ?? null)
            .catch(err => console.error('[supply/webhook] forwardToSupplyChatService error:', err.message));
        }
      }
    }
  } catch (err) {
    console.error('[supply/webhook] Top-level error:', err.message);
  }
});

// ── Keep the old /whatsapp/status alias for backwards compat ──────────────────
// Remove once Meta webhook URL is updated to /whatsapp
router.get('/whatsapp/status', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected  = process.env.SUPPLY_WEBHOOK_VERIFY_TOKEN
                      || process.env.META_WEBHOOK_VERIFY_TOKEN
                      || process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && expected && token === expected) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ── Forward to supply chat service ────────────────────────────────────────────
// Sends a minimal WhatsApp Business API-shaped payload plus resolved context
// fields (supplier_id, client_id) so the Python agent doesn't need to re-query.

async function forwardToSupplyChatService(message, metadata, value, supplierId, clientId) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          ...value,
          messages:  [message],
          metadata,
          // Injected context — not part of the Meta spec but consumed by the supply agent
          _supply_context: {
            supplier_id: supplierId,
            client_id:   clientId,   // null if client not yet registered
          },
        },
      }],
    }],
  };

  const response = await fetch(`${SUPPLY_CHAT_URL}/webhook/supply`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
    signal:  AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`[supply/webhook] Supply chat returned ${response.status}: ${body.slice(0, 200)}`);
  } else {
    console.log(`[supply/webhook] ✅ Forwarded ${message.type} from ${message.from} → supplier ${supplierId}`);
  }
}

module.exports = router;
