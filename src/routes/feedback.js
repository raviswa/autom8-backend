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
const path    = require('path');

const { supabaseAdmin }       = require('../config/supabase');
const { queueFeedbackForTable } = require('../helpers/feedback');
const {
  sendFeedbackInvite,
  aspectsForRating,
  resolveVisitContext,
  completeFeedback,
} = require('../helpers/feedbackFlow');
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

// ── POST /api/feedback/handle-reply ─────────────────────────────────────────
// Internal: Python chat (or other services) delegate feedback replies here.

router.post('/handle-reply', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const bearer     = authHeader?.split(' ')[1];

  if (!isValidKdsSecret(bearer)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { customer_phone, restaurant_id, message } = req.body || {};
  if (!customer_phone || !restaurant_id || !message) {
    return res.status(400).json({ error: 'customer_phone, restaurant_id, and message required' });
  }

  const { handleFeedbackReply } = require('../helpers/feedbackFlow');
  const result = await handleFeedbackReply(customer_phone, message, restaurant_id);
  return res.json({
    consumed: !!result?.consumed,
    completed: !!result?.completed,
  });
});

// ── POST /api/feedback/dismiss ───────────────────────────────────────────────
// Internal: dismiss stale feedback invite when customer sends Home/Menu.

router.post('/dismiss', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const bearer     = authHeader?.split(' ')[1];

  if (!isValidKdsSecret(bearer)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { customer_phone, restaurant_id } = req.body || {};
  if (!customer_phone || !restaurant_id) {
    return res.status(400).json({ error: 'customer_phone and restaurant_id required' });
  }

  const { dismissActiveFeedback } = require('../helpers/feedbackFlow');
  const { phoneVariants } = require('../helpers/conversationState');
  await dismissActiveFeedback(restaurant_id, customer_phone).catch(() => {});
  for (const variant of phoneVariants(customer_phone)) {
    await closeOpenFeedbackRows(restaurant_id, variant).catch(() => {});
  }
  return res.json({ success: true });
});

// ── GET /api/feedback/form-session ──────────────────────────────────────────
// Resolves a web-form session token to visit context (name, token/table,
// whether it's already been submitted). Phone-bound + expiry-checked, same
// pattern as webcart's menu_tokens session resolution.

router.get('/form-session', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    const phone = String(req.query.phone || '').replace(/\D/g, '');
    if (!token || !phone) {
      return res.status(400).json({ ok: false, error: 'token and phone are required.' });
    }

    const { phoneVariants } = require('../helpers/conversationState');
    const variants = phoneVariants(phone);

    const { data: record, error } = await supabaseAdmin
      .from('feedback_pending')
      .select('*')
      .eq('web_session_token', token)
      .in('customer_phone', variants.length ? variants : [phone])
      .maybeSingle();

    if (error) throw error;
    if (!record) {
      return res.status(404).json({ ok: false, error: 'This feedback link is invalid.' });
    }
    if (record.web_token_expires_at && new Date(record.web_token_expires_at) < new Date()) {
      return res.status(410).json({ ok: false, error: 'This feedback link has expired.' });
    }
    if (record.feedback_received_at || record.web_submitted_at) {
      return res.json({
        ok: true,
        already_submitted: true,
        customer_name: record.customer_name || 'Guest',
      });
    }

    const { contextLine, thanksLine } = await resolveVisitContext(record);

    return res.json({
      ok: true,
      already_submitted: false,
      customer_name: record.customer_name || 'Guest',
      context_line: contextLine,
      thanks_line: thanksLine,
      aspects: {
        positive:    aspectsForRating(5)[0],
        improvement: aspectsForRating(3)[0],
        negative:    aspectsForRating(1)[0],
      },
    });
  } catch (err) {
    console.error('[feedback/form-session]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load feedback form.' });
  }
});

// ── POST /api/feedback/submit-form ──────────────────────────────────────────
// Single submission from the web form: rating + aspects + comment together,
// replacing the 3-message WhatsApp back-and-forth. Reuses completeFeedback()
// so the DB write, thank-you message, and manager alert stay identical to
// the chat-based path.

router.post('/submit-form', async (req, res) => {
  try {
    const { token, phone: rawPhone, rating: rawRating, aspects, comment } = req.body || {};
    const token_ = String(token || '').trim();
    const phone = String(rawPhone || '').replace(/\D/g, '');
    const rating = Number(rawRating);

    if (!token_ || !phone) {
      return res.status(400).json({ ok: false, error: 'token and phone are required.' });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ ok: false, error: 'A rating between 1 and 5 is required.' });
    }

    const { phoneVariants } = require('../helpers/conversationState');
    const variants = phoneVariants(phone);

    const { data: record, error } = await supabaseAdmin
      .from('feedback_pending')
      .select('*')
      .eq('web_session_token', token_)
      .in('customer_phone', variants.length ? variants : [phone])
      .maybeSingle();

    if (error) throw error;
    if (!record) {
      return res.status(404).json({ ok: false, error: 'This feedback link is invalid.' });
    }
    if (record.web_token_expires_at && new Date(record.web_token_expires_at) < new Date()) {
      return res.status(410).json({ ok: false, error: 'This feedback link has expired.' });
    }
    if (record.feedback_received_at || record.web_submitted_at) {
      return res.json({ ok: true, already_submitted: true });
    }

    const [validAspects] = aspectsForRating(rating);
    const validIds = new Set(validAspects.map(([id]) => id));
    const aspectIds = Array.isArray(aspects) ? aspects.filter(a => validIds.has(a)) : [];
    const safeComment = comment ? String(comment).trim().slice(0, 500) || null : null;

    await supabaseAdmin
      .from('feedback_pending')
      .update({ web_submitted_at: new Date().toISOString() })
      .eq('id', record.id);

    await completeFeedback(record, rating, aspectIds, safeComment, phone);

    return res.json({ ok: true, already_submitted: false });
  } catch (err) {
    console.error('[feedback/submit-form]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to submit feedback.' });
  }
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
