'use strict';

/**
 * DB-persisted scheduled jobs — KDS dispatch + prep-start WhatsApp.
 */

const { supabaseAdmin } = require('../config/supabase');
const { broadcastToRestaurant } = require('../websocket');
const { sendWhatsAppMessage } = require('./whatsapp');
const { notifyKdsFromPayload } = require('./kdsNotifyClient');

async function enqueueScheduledJobs({
  restaurantId,
  bookingId,
  tokenId,
  kitchenStartAt,
  payload = {},
}) {
  const runAt = new Date(kitchenStartAt);
  if (Number.isNaN(runAt.getTime())) {
    throw new Error('invalid kitchenStartAt');
  }

  const jobs = [
    {
      restaurant_id: restaurantId,
      booking_id: bookingId,
      token_id: tokenId,
      job_type: 'kds_dispatch',
      run_at: runAt.toISOString(),
      status: 'pending',
      idempotency_key: `kds_dispatch:${bookingId}`,
      payload,
    },
    {
      restaurant_id: restaurantId,
      booking_id: bookingId,
      token_id: tokenId,
      job_type: 'prep_start_whatsapp',
      run_at: runAt.toISOString(),
      status: 'pending',
      idempotency_key: `prep_start_whatsapp:${bookingId}`,
      payload,
    },
  ];

  const { error } = await supabaseAdmin.from('scheduled_jobs').upsert(jobs, {
    onConflict: 'idempotency_key',
    ignoreDuplicates: false,
  });
  if (error) throw error;
  return jobs.length;
}

async function cancelScheduledJobsForBooking(bookingId) {
  const { error } = await supabaseAdmin
    .from('scheduled_jobs')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('booking_id', bookingId)
    .eq('status', 'pending');
  if (error) throw error;
}

async function cancelScheduledJobsForToken(tokenId) {
  const { error } = await supabaseAdmin
    .from('scheduled_jobs')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('token_id', tokenId)
    .eq('status', 'pending');
  if (error) throw error;
}

async function claimDueJobs(limit = 25) {
  const now = new Date().toISOString();
  const { data: due, error } = await supabaseAdmin
    .from('scheduled_jobs')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', now)
    .order('run_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return due ?? [];
}

async function markJob(jobId, status, extra = {}) {
  await supabaseAdmin.from('scheduled_jobs').update({
    status,
    updated_at: new Date().toISOString(),
    ...(status === 'completed' ? { completed_at: new Date().toISOString() } : {}),
    ...extra,
  }).eq('id', jobId);
}

async function executeKdsDispatchJob(job) {
  const payload = job.payload || {};
  const orderId = await notifyKdsFromPayload({
    restaurant_id: job.restaurant_id,
    customer_name: payload.customer_name,
    customer_phone: payload.customer_phone,
    token_number: payload.token_number || job.token_id,
    service_type: payload.service_type || 'takeaway',
    items: payload.items || [],
    special_notes: payload.special_notes || null,
    booking_id: job.booking_id,
    create_kot: true,
  });

  if (!orderId) {
    throw new Error('KDS/KOT creation failed');
  }

  await supabaseAdmin.from('bookings')
    .update({ kds_sent_at: new Date().toISOString(), status: 'confirmed' })
    .eq('id', job.booking_id);

  broadcastToRestaurant(job.restaurant_id, {
    type: 'SCHEDULED_KDS_DISPATCH',
    booking_id: job.booking_id,
    token_id: job.token_id,
    order_id: orderId,
    timestamp: new Date().toISOString(),
  });

  return orderId;
}

async function executePrepStartWhatsappJob(job) {
  const payload = job.payload || {};
  const phone = payload.customer_phone;
  if (!phone) return;

  const slotLabel = payload.slot_label || 'your slot';
  const startLabel = payload.kitchen_start_label || '';
  const token = payload.token_number || job.token_id || '—';

  await sendWhatsAppMessage(
    phone,
    `👨‍🍳 We're starting your order now!\n`
    + `Token ${token} · Slot: ${slotLabel}\n`
    + (startLabel ? `Kitchen started at ${startLabel}. ` : '')
    + `We'll message you when it's ready. 🙏`,
    job.restaurant_id,
  );
}

async function runDueScheduledJobs() {
  const due = await claimDueJobs();
  let executed = 0;

  for (const job of due) {
    const { data: locked } = await supabaseAdmin
      .from('scheduled_jobs')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'pending')
      .select()
      .maybeSingle();

    if (!locked) continue;

    try {
      if (job.job_type === 'kds_dispatch') {
        await executeKdsDispatchJob(job);
      } else if (job.job_type === 'prep_start_whatsapp') {
        await executePrepStartWhatsappJob(job);
      }
      await markJob(job.id, 'completed');
      executed += 1;
    } catch (err) {
      console.error(`[scheduled-jobs] ${job.job_type} ${job.id} failed:`, err.message);
      await markJob(job.id, 'failed', { last_error: err.message });
    }
  }

  return executed;
}

module.exports = {
  enqueueScheduledJobs,
  cancelScheduledJobsForBooking,
  cancelScheduledJobsForToken,
  runDueScheduledJobs,
};
