// src/routes/feedback.js
// ============================================================================
// Feedback queue endpoint + scheduler
//
// POST /api/feedback/queue     — Internal: queue a feedback request for a table
//                                Auth: Bearer <KDS_SECRET> (from Python agent)
//                                OR: Supabase JWT (from manager dashboard)
// startFeedbackScheduler()    — Exported: called by schedulers/index.js
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin }       = require('../config/supabase');
const { sendWhatsAppMessage } = require('../helpers/whatsapp');
const { queueFeedbackForTable } = require('../helpers/feedback');

const { isValidKdsSecret } = require('../config/internalSecret');

// ── POST /api/feedback/queue ──────────────────────────────────────────────────
// Accepts two auth schemes:
//   1. Bearer <KDS_SECRET>  — used by the Python booking agent
//   2. Bearer <Supabase JWT> — used by the manager dashboard

router.post('/queue', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const bearer     = authHeader?.split(' ')[1];

  // Scheme 1: internal secret (Python agent)
  const isInternalSecret = isValidKdsSecret(bearer);

  // Scheme 2: Supabase JWT (dashboard)
  let isValidJWT = false;
  if (!isInternalSecret && bearer) {
    try {
      const { data: { user } } = await supabaseAdmin.auth.getUser(bearer);
      isValidJWT = !!user;
    } catch (_) {}
  }

  if (!isInternalSecret && !isValidJWT) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    restaurant_id,
    customer_phone,
    customer_name = 'Guest',
    token_number  = null,
    table_id      = null,
    source        = 'api',
  } = req.body;

  if (!restaurant_id || !customer_phone)
    return res.status(400).json({ error: 'restaurant_id and customer_phone required' });

  await queueFeedbackForTable({
    tableId:       table_id,
    customerPhone: customer_phone,
    customerName:  customer_name,
    tokenId:       token_number,
    restaurantId:  restaurant_id,
    source,
  });

  res.json({ success: true });
});

// ── startFeedbackScheduler ────────────────────────────────────────────────────
// Polls feedback_pending every 10 minutes for records where:
//   feedback_sent = false AND freed_at <= now() - 2 hours
//
// Per-record try/catch means a single failed WA send doesn't abort the batch.

function startFeedbackScheduler() {
  setInterval(async () => {
    try {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      const { data: pending, error: queryErr } = await supabaseAdmin
        .from('feedback_pending')
        .select('*')
        .eq('feedback_sent', false)
        .lte('freed_at', twoHoursAgo)
        .limit(20);

      if (queryErr) { console.error('[feedback-scheduler] Query error:', queryErr.message); return; }

      const sentPhones = new Set();

      for (const record of pending ?? []) {
        try {
          const dedupeKey = `${record.restaurant_id}:${record.customer_phone}`;

          // Extra pending rows for the same customer — mark sent, do not message again
          if (sentPhones.has(dedupeKey)) {
            await supabaseAdmin
              .from('feedback_pending')
              .update({ feedback_sent: true, feedback_sent_at: new Date().toISOString() })
              .eq('id', record.id)
              .eq('feedback_sent', false);
            continue;
          }

          // Atomic claim — prevents duplicate sends across scheduler ticks / instances
          const { data: claimed, error: claimErr } = await supabaseAdmin
            .from('feedback_pending')
            .update({ feedback_sent: true, feedback_sent_at: new Date().toISOString() })
            .eq('id', record.id)
            .eq('feedback_sent', false)
            .select('id')
            .maybeSingle();

          if (claimErr || !claimed) {
            console.info(`[feedback-scheduler] Skipped ${record.customer_phone} — already claimed`);
            continue;
          }

          sentPhones.add(dedupeKey);

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
            `You can also add comments after your rating. 🙏`,
            record.restaurant_id
          );

          // Close any other open rows for this customer (legacy duplicates)
          await supabaseAdmin
            .from('feedback_pending')
            .update({ feedback_sent: true, feedback_sent_at: new Date().toISOString() })
            .eq('restaurant_id', record.restaurant_id)
            .eq('customer_phone', record.customer_phone)
            .eq('feedback_sent', false);

          console.log(`[feedback-scheduler] ✅ Sent to ${record.customer_phone}`);
        } catch (innerErr) {
          console.error(`[feedback-scheduler] Failed for ${record.customer_phone}:`, innerErr.message);
        }
      }
    } catch (err) {
      console.error('[feedback-scheduler] Scan error:', err.message);
    }
  }, 10 * 60 * 1000);

  console.log('📣 Feedback scheduler started (polls every 10 min, 2-hr post-visit delay)');
}

module.exports = router;
module.exports.startFeedbackScheduler = startFeedbackScheduler;
