'use strict';

/**
 * DB-persisted scheduled jobs — KDS dispatch + prep-start WhatsApp.
 */

const { supabaseAdmin } = require('../config/supabase');
const { broadcastToRestaurant } = require('../websocket');
const { sendWhatsAppMessage } = require('./whatsapp');
const { notifyKdsFromPayload } = require('./kdsNotifyClient');

function buildItemsFromCart(cart) {
  if (!cart || typeof cart !== 'object') return [];
  return Object.entries(cart).map(([id, line]) => ({
    retailer_id: id,
    name: line?.title || line?.name || 'Item',
    qty: Number(line?.qty ?? 1),
    unit_price: Number(line?.unit_price ?? 0),
  }));
}

function resolvePortalToken(tokens, booking) {
  const byBooking = (tokens ?? []).find((t) => t.meta?.booking_id === booking.id);
  if (byBooking) return byBooking;
  const raw = String(booking.token_number || '').trim().toUpperCase();
  if (!raw) return null;
  return (tokens ?? []).find((t) => {
    const id = String(t.id || '').toUpperCase();
    return id === raw || id === `T-${raw}` || raw === id.replace(/^T-/, '');
  }) || null;
}

/** Upsert scheduled_jobs from paid bookings so kitchen_start_at dispatch is reliable. */
async function syncScheduledJobsFromBookings() {
  const { data: bookings, error } = await supabaseAdmin
    .from('bookings')
    .select(`
      id, restaurant_id, kitchen_start_at, token_number, service_type, schedule_meta,
      customer:customer_id(name, phone)
    `)
    .in('service_type', ['takeaway', 'delivery'])
    .in('status', ['confirmed', 'pending'])
    .eq('payment_status', 'paid')
    .is('kds_sent_at', null)
    .not('kitchen_start_at', 'is', null)
    .limit(100);

  if (error) {
    console.warn('[scheduled-jobs] sync query failed:', error.message);
    return 0;
  }
  if (!bookings?.length) return 0;

  const byRestaurant = new Map();
  for (const b of bookings) {
    if (!byRestaurant.has(b.restaurant_id)) byRestaurant.set(b.restaurant_id, []);
    byRestaurant.get(b.restaurant_id).push(b);
  }

  let synced = 0;
  for (const [restaurantId, rows] of byRestaurant) {
    const { data: tokens } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('id, meta, type')
      .eq('restaurant_id', restaurantId)
      .in('type', ['scheduled_takeaway', 'scheduled_delivery']);

    for (const b of rows) {
      const portal = resolvePortalToken(tokens, b);
      const meta = b.schedule_meta || {};
      const portalMeta = portal?.meta || {};
      const cart = (meta.cart && Object.keys(meta.cart).length) ? meta.cart : (portalMeta.cart || {});
      const items = buildItemsFromCart(cart);
      if (!items.length) continue;

      const portalType = String(portal?.type || '').toLowerCase();
      const serviceType = portalType === 'scheduled_delivery'
        ? 'delivery'
        : portalType === 'scheduled_takeaway'
          ? 'takeaway'
          : (b.service_type || 'takeaway');
      const tokenId = portal?.id || b.token_number;
      const customer = b.customer || {};

      try {
        await enqueueScheduledJobs({
          restaurantId,
          bookingId: b.id,
          tokenId,
          kitchenStartAt: b.kitchen_start_at,
          payload: {
            customer_name: customer.name || 'Guest',
            customer_phone: customer.phone || '',
            token_number: tokenId,
            service_type: serviceType,
            items,
            slot_label: meta.scheduled_at_label || portalMeta.scheduled_at_label || '',
            kitchen_start_label: meta.kitchen_start_label || portalMeta.kitchen_start_label || '',
          },
        });
        synced += 1;
      } catch (err) {
        console.warn(`[scheduled-jobs] sync failed for ${b.id}:`, err.message);
      }
    }
  }
  return synced;
}

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
  await syncScheduledJobsFromBookings();
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
  syncScheduledJobsFromBookings,
  runDueScheduledJobs,
};
