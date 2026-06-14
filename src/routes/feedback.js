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
const { queueFeedbackForTable } = require('../helpers/feedback');
const { sendFeedbackInvite } = require('../helpers/feedbackFlow');
const {
  wasInviteSentRecently,
  closeOpenFeedbackRows,
  hasInFlightSend,
} = require('../helpers/feedbackDedup');

const { isValidKdsSecret } = require('../config/internalSecret');

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const POST_VISIT_DELAY_MS = 2 * 60 * 60 * 1000;
const SEND_LEASE_MS = 15 * 60 * 1000;

let schedulerStarted = false;

// ── POST /api/feedback/queue ──────────────────────────────────────────────────

router.post('/queue', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const bearer     = authHeader?.split(' ')[1];

  const isInternalSecret = isValidKdsSecret(bearer);

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

// ── Scheduler helpers ─────────────────────────────────────────────────────────

async function releaseSendLease(id) {
  await supabaseAdmin
    .from('feedback_pending')
    .update({ feedback_sent_at: null })
    .eq('id', id)
    .eq('feedback_sent', false);
}

async function acquireSendLease(record) {
  const now = new Date().toISOString();
  const leaseStaleBefore = new Date(Date.now() - SEND_LEASE_MS).toISOString();

  const { data: leased, error: leaseErr } = await supabaseAdmin
    .from('feedback_pending')
    .update({ feedback_sent_at: now })
    .eq('id', record.id)
    .eq('restaurant_id', record.restaurant_id)
    .eq('customer_phone', record.customer_phone)
    .eq('feedback_sent', false)
    .is('feedback_sent_at', null)
    .select('*')
    .maybeSingle();

  if (leaseErr) throw leaseErr;
  if (leased) return leased;

  if (await hasInFlightSend(record.restaurant_id, record.customer_phone, SEND_LEASE_MS)) {
    return null;
  }

  const { data: reclaimed, error: reclaimErr } = await supabaseAdmin
    .from('feedback_pending')
    .update({ feedback_sent_at: now })
    .eq('id', record.id)
    .eq('restaurant_id', record.restaurant_id)
    .eq('customer_phone', record.customer_phone)
    .eq('feedback_sent', false)
    .lt('feedback_sent_at', leaseStaleBefore)
    .select('*')
    .maybeSingle();

  if (reclaimErr) throw reclaimErr;
  return reclaimed;
}

async function markRowsSentById(ids, sentAt) {
  if (!ids.length) return;
  await supabaseAdmin
    .from('feedback_pending')
    .update({ feedback_sent: true, feedback_sent_at: sentAt })
    .in('id', ids)
    .eq('feedback_sent', false);
}

function groupPendingByCustomer(pending) {
  const primaryByCustomer = new Map();
  const duplicateIds = [];

  for (const record of pending) {
    const key = `${record.restaurant_id}:${record.customer_phone}`;
    const existing = primaryByCustomer.get(key);
    if (!existing) {
      primaryByCustomer.set(key, record);
      continue;
    }

    const keepExisting =
      new Date(existing.freed_at).getTime() <= new Date(record.freed_at).getTime();
    if (keepExisting) {
      duplicateIds.push(record.id);
    } else {
      duplicateIds.push(existing.id);
      primaryByCustomer.set(key, record);
    }
  }

  return { primaryByCustomer, duplicateIds };
}

// ── runFeedbackSchedulerTick ──────────────────────────────────────────────────
// Exactly one WhatsApp invite per restaurant+phone per 24 h, even with multiple
// API instances or duplicate feedback_pending rows.

async function runFeedbackSchedulerTick() {
  const twoHoursAgo = new Date(Date.now() - POST_VISIT_DELAY_MS).toISOString();

  const { data: pending, error: queryErr } = await supabaseAdmin
    .from('feedback_pending')
    .select('*')
    .eq('feedback_sent', false)
    .lte('freed_at', twoHoursAgo)
    .order('freed_at', { ascending: true })
    .limit(50);

  if (queryErr) {
    console.error('[feedback-scheduler] Query error:', queryErr.message);
    return;
  }

  if (!pending?.length) return;

  const { primaryByCustomer, duplicateIds } = groupPendingByCustomer(pending);
  const sentAt = new Date().toISOString();
  await markRowsSentById(duplicateIds, sentAt);

  for (const record of primaryByCustomer.values()) {
    try {
      const { restaurant_id: restaurantId, customer_phone: phone } = record;

      if (await wasInviteSentRecently(restaurantId, phone)) {
        const closed = await closeOpenFeedbackRows(restaurantId, phone, sentAt);
        if (closed) {
          console.info(
            `[feedback-scheduler] Skipped ${phone} — invite already sent within cooldown (${closed} row(s) closed)`
          );
        }
        continue;
      }

      if (await hasInFlightSend(restaurantId, phone, SEND_LEASE_MS)) {
        console.info(`[feedback-scheduler] Skipped ${phone} — send in progress on another instance`);
        continue;
      }

      const leased = await acquireSendLease(record);
      if (!leased) {
        console.info(`[feedback-scheduler] Skipped ${phone} — could not acquire send lease`);
        continue;
      }

      if (await wasInviteSentRecently(restaurantId, phone)) {
        await releaseSendLease(leased.id);
        await closeOpenFeedbackRows(restaurantId, phone, sentAt);
        console.info(`[feedback-scheduler] Skipped ${phone} — invite sent by peer during lease`);
        continue;
      }

      const delivered = await sendFeedbackInvite(leased);
      if (!delivered) {
        await releaseSendLease(leased.id);
        console.error(`[feedback-scheduler] WhatsApp send failed for ${phone} — will retry`);
        continue;
      }

      const deliveredAt = new Date().toISOString();
      await closeOpenFeedbackRows(restaurantId, phone, deliveredAt);

      console.log(`[feedback-scheduler] ✅ Sent to ${phone}`);
    } catch (innerErr) {
      console.error(`[feedback-scheduler] Failed for ${record.customer_phone}:`, innerErr.message);
      await releaseSendLease(record.id).catch(() => {});
    }
  }
}

// ── startFeedbackScheduler ────────────────────────────────────────────────────

function startFeedbackScheduler() {
  if (schedulerStarted) {
    console.warn('[feedback-scheduler] Already started — skipping duplicate registration');
    return;
  }
  schedulerStarted = true;

  runFeedbackSchedulerTick().catch((err) => {
    console.error('[feedback-scheduler] Initial tick error:', err.message);
  });

  setInterval(() => {
    runFeedbackSchedulerTick().catch((err) => {
      console.error('[feedback-scheduler] Tick error:', err.message);
    });
  }, POLL_INTERVAL_MS);

  console.log('📣 Feedback scheduler started (polls every 10 min, 2-hr post-visit delay, 24h dedup)');
}

module.exports = router;
module.exports.startFeedbackScheduler = startFeedbackScheduler;
module.exports.runFeedbackSchedulerTick = runFeedbackSchedulerTick;
