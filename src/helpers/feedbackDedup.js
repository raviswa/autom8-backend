// src/helpers/feedbackDedup.js
// Shared dedup helpers — one WhatsApp invite per customer per restaurant.

'use strict';

const { supabaseAdmin } = require('../config/supabase');

/** Do not send another invite within this window (ms). */
const SEND_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function cooldownSinceIso() {
  return new Date(Date.now() - SEND_COOLDOWN_MS).toISOString();
}

async function wasInviteSentRecently(restaurantId, phone) {
  const { data, error } = await supabaseAdmin
    .from('feedback_pending')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('customer_phone', phone)
    .eq('feedback_sent', true)
    .not('feedback_sent_at', 'is', null)
    .gte('feedback_sent_at', cooldownSinceIso())
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

/** Mark every open row for this customer sent — no WhatsApp message. */
async function closeOpenFeedbackRows(restaurantId, phone, sentAt = new Date().toISOString()) {
  const { data, error } = await supabaseAdmin
    .from('feedback_pending')
    .update({ feedback_sent: true, feedback_sent_at: sentAt })
    .eq('restaurant_id', restaurantId)
    .eq('customer_phone', phone)
    .eq('feedback_sent', false)
    .select('id');

  if (error) throw error;
  return data?.length ?? 0;
}

async function hasInFlightSend(restaurantId, phone, leaseMs) {
  const leaseFreshAfter = new Date(Date.now() - leaseMs).toISOString();
  const { data, error } = await supabaseAdmin
    .from('feedback_pending')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('customer_phone', phone)
    .eq('feedback_sent', false)
    .not('feedback_sent_at', 'is', null)
    .gt('feedback_sent_at', leaseFreshAfter)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

module.exports = {
  SEND_COOLDOWN_MS,
  wasInviteSentRecently,
  closeOpenFeedbackRows,
  hasInFlightSend,
};
