// src/helpers/feedback.js
// ============================================================================
// queueFeedbackForTable — shared helper called by any event that frees a table.
//
// Callers:
//   • tokens.js  PUT /:id/complete    (manager marks visit done)
//   • schedulers/index.js             (auto-release after 90 min)
//   • pos.js     POST /payments       (POS payment checkout)
//
// Inserts a feedback_pending row with freed_at = now().
// The feedback scheduler (startFeedbackScheduler) picks it up 2 hours later
// and dispatches the WhatsApp star-rating invitation.
//
// All errors are swallowed — a DB failure here must NEVER block the caller.
// ============================================================================

'use strict';

const { supabaseAdmin } = require('../config/supabase');

/**
 * Queue a post-visit feedback request for a table.
 *
 * @param {object} opts
 * @param {string}  opts.tableId        — UUID of the freed table row
 * @param {string}  opts.customerPhone  — Raw phone string (sanitised internally)
 * @param {string}  [opts.customerName] — Display name (falls back to 'Guest')
 * @param {string}  [opts.tokenId]      — walk_in_tokens.id for audit/display
 * @param {string}  opts.restaurantId   — UUID of the restaurant
 * @param {string}  [opts.source]       — Logging label (e.g. 'token-complete')
 */
async function queueFeedbackForTable({
  tableId,
  customerPhone,
  customerName  = 'Guest',
  tokenId       = null,
  restaurantId,
  source        = 'unknown',
}) {
  try {
    const cleanPhone = String(customerPhone ?? '').replace(/\D/g, '');

    // Guard: no phone → feedback via WhatsApp is impossible
    if (!cleanPhone) {
      console.info(`[feedback-queue] Skipped — no phone for token ${tokenId} (${source})`);
      return;
    }

    // Resolve table_number for the feedback message if not supplied
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
        token_number:   tokenId       ?? null,
        table_number:   tableNumber   !== null ? String(tableNumber) : null,
        freed_at:       new Date().toISOString(),
        feedback_sent:  false,
        manager_notified: false,
      });

    if (insertErr) {
      console.error(`[feedback-queue] Insert failed (${source}):`, insertErr.message);
      return;
    }

    console.info(
      `[feedback-queue] ✅ Queued for ${cleanPhone}` +
      ` | table ${tableNumber ?? 'N/A'}` +
      ` | source: ${source}`
    );
  } catch (err) {
    // Swallow: feedback queue failure must never propagate to the caller
    console.error(`[feedback-queue] Unexpected error (${source}):`, err.message);
  }
}

module.exports = { queueFeedbackForTable };
