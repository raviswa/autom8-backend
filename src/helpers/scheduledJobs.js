'use strict';

/**
 * DB-persisted scheduled jobs — KDS dispatch + prep-start WhatsApp.
 *
 * FIX (scheduled-order-leaks-to-live, Issue 2): dispatchBookingToKds() is the single
 * function that actually writes kds_items for a scheduled booking, and it is called
 * from four different places — the job queue (runDueScheduledJobs*), reconciliation
 * (reconcileMissedKdsDispatches), the KDS "present" bucket poll (src/routes/pos.js),
 * and indirectly via the Python webhook fulfillment path retrying through here. Three
 * of those four callers already re-check kitchen_start_at against a fresh DB read
 * before calling in; the Python webhook path was found to rely on a possibly-stale
 * in-memory session snapshot instead. Rather than trying to audit every current and
 * future caller, dispatchBookingToKds() now refuses to dispatch anything whose
 * kitchen_start_at is still in the future, regardless of who called it. This makes
 * it the single enforced chokepoint for "is it actually time to go live" — see
 * matching change in tools/prepay_fulfillment.py::_dispatch_to_kds for the Python
 * side of the same guarantee.
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
    if (id === raw) return true;
    if (id === `T-${raw}` || raw === id.replace(/^T-/, '')) return true;
    const monthly = id.match(/^T-\d{4}-(\d+)$/);
    if (monthly && (`T-${monthly[1]}` === raw || monthly[1] === raw.replace(/^T-/, ''))) return true;
    return false;
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
  // Hard gate: never dispatch before booking.kitchen_start_at (cook/pack/transit math).
  if (job.booking_id) {
    const { data: booking } = await supabaseAdmin
      .from('bookings')
      .select('kitchen_start_at, scheduled_slot_at, booking_datetime, kds_sent_at')
      .eq('id', job.booking_id)
      .maybeSingle();
    if (booking?.kds_sent_at) {
      console.log(`[scheduled-jobs] booking ${job.booking_id} already on KDS — skip`);
      return booking.kds_sent_at;
    }
    const ksRaw = booking?.kitchen_start_at || job.run_at;
    if (ksRaw) {
      const ks = new Date(ksRaw).getTime();
      if (Number.isFinite(ks) && ks > Date.now() + 15_000) {
        console.warn(
          `[scheduled-release] REFUSED job KDS dispatch booking=${job.booking_id} ` +
          `kitchen_start_at=${ksRaw} still future — reschedule job`,
        );
        await supabaseAdmin.from('scheduled_jobs').update({
          status: 'pending',
          run_at: new Date(ks).toISOString(),
          updated_at: new Date().toISOString(),
          last_error: 'released_too_early',
        }).eq('id', job.id);
        return null;
      }
    }
  }

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

/**
 * Push one paid scheduled booking to KDS — one ribbon (kds_item) per cart line.
 *
 * This is the single enforced chokepoint for "may this booking go live right now".
 * Every caller — the job queue, reconciliation, the /kds/scheduled "present" bucket
 * poll, and manual retries — funnels through here, and it refuses to write kds_items
 * if the booking's own kitchen_start_at is still in the future, regardless of what
 * the caller believed. See module header comment for why this exists.
 */
async function dispatchBookingToKds(restaurantId, order) {
  // Hard release gate — re-checked here regardless of caller, so a stale or
  // incorrect upstream defer decision can never result in an early live dispatch.
  if (order.kitchen_start_at) {
    const ks = new Date(order.kitchen_start_at).getTime();
    if (Number.isFinite(ks) && ks > Date.now()) {
      console.warn(
        `[scheduled-release] REFUSED early dispatch booking=${order.booking_id} ` +
        `token=${order.token_number} kitchen_start_at=${order.kitchen_start_at} ` +
        `(${Math.round((ks - Date.now()) / 60000)} min in the future) — not writing kds_items`
      );
      return false;
    }
  }

  const cart = order.cart || order.schedule_meta?.cart || {};
  const items = buildItemsFromCart(cart);
  if (!items.length) {
    console.warn(`[scheduled-dispatch] booking ${order.booking_id} — empty cart, skip`);
    return false;
  }

  const job = {
    restaurant_id: restaurantId,
    booking_id: order.booking_id,
    token_id: order.token_number,
    payload: {
      customer_name: order.customer_name || 'Guest',
      customer_phone: order.customer_phone || '',
      token_number: order.token_number,
      service_type: order.service_type || 'takeaway',
      items,
      special_notes: order.schedule_meta?.special_notes || null,
    },
  };

  try {
    await executeKdsDispatchJob(job);
    console.log(
      `[scheduled-release] booking=${order.booking_id} released to KDS ` +
      `token=${order.token_number} (${items.length} ribbon(s), kitchen_start_at=${order.kitchen_start_at || 'n/a'})`
    );
    return true;
  } catch (err) {
    console.error(`[scheduled-dispatch] ${order.booking_id} failed:`, err.message);
    return false;
  }
}

async function processDueJobs(due) {
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

async function retryFailedDispatchJobs(restaurantId = null) {
  let q = supabaseAdmin
    .from('scheduled_jobs')
    .update({ status: 'pending', last_error: null, updated_at: new Date().toISOString() })
    .eq('job_type', 'kds_dispatch')
    .eq('status', 'failed');
  if (restaurantId) q = q.eq('restaurant_id', restaurantId);
  const { error } = await q;
  if (error) console.warn('[scheduled-jobs] retry failed jobs:', error.message);
}

/** Run due jobs for one outlet — used when KDS polls scheduled board. */
async function runDueScheduledJobsForRestaurant(restaurantId) {
  await syncScheduledJobsFromBookings();
  await retryFailedDispatchJobs(restaurantId);
  const now = new Date().toISOString();
  const { data: due, error } = await supabaseAdmin
    .from('scheduled_jobs')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'pending')
    .lte('run_at', now)
    .order('run_at', { ascending: true })
    .limit(25);
  if (error) {
    console.warn(`[scheduled-jobs] due query failed for ${restaurantId}:`, error.message);
    return 0;
  }
  return processDueJobs(due ?? []);
}

async function runDueScheduledJobs() {
  await syncScheduledJobsFromBookings();
  await retryFailedDispatchJobs();
  const due = await claimDueJobs();
  return processDueJobs(due);
}

/** Paid bookings past kitchen_start_at but never dispatched — repair on KDS poll. */
async function reconcileMissedKdsDispatches(restaurantId) {
  const now = new Date().toISOString();
  const { data: bookings, error } = await supabaseAdmin
    .from('bookings')
    .select(`
      id, token_number, kitchen_start_at, schedule_meta, service_type, kds_sent_at,
      status, payment_status,
      customer:customer_id(name, phone)
    `)
    .eq('restaurant_id', restaurantId)
    .in('service_type', ['takeaway', 'delivery'])
    .eq('payment_status', 'paid')
    .in('status', ['pending', 'confirmed'])
    .is('kds_sent_at', null)
    .not('kitchen_start_at', 'is', null)
    .lte('kitchen_start_at', now)
    .order('kitchen_start_at', { ascending: true })
    .limit(15);

  if (error) {
    console.warn(`[scheduled-dispatch] reconcile query failed:`, error.message);
    return 0;
  }

  let dispatched = 0;
  for (const b of bookings ?? []) {
    const meta = b.schedule_meta || {};
    const order = {
      booking_id: b.id,
      token_number: b.token_number,
      customer_name: b.customer?.name,
      customer_phone: b.customer?.phone,
      service_type: b.service_type,
      cart: meta.cart || {},
      schedule_meta: meta,
      kitchen_start_at: b.kitchen_start_at,
    };
    if (await dispatchBookingToKds(restaurantId, order)) dispatched += 1;
  }
  if (dispatched) {
    console.log(`[scheduled-dispatch] reconciled ${dispatched} missed booking(s) for ${restaurantId}`);
  }
  return dispatched;
}

function explainKdsVisibility(booking, kdsItems = []) {
  const reasons = [];
  if (!booking) {
    reasons.push('Booking not found.');
    return reasons;
  }
  if (booking.status === 'cancelled') {
    reasons.push('Booking was cancelled (often superseded when a new order replaced an unpaid token).');
  }
  if (booking.payment_status !== 'paid') {
    reasons.push(`Payment status is "${booking.payment_status}" — KDS only receives paid scheduled orders.`);
  }
  if (!booking.kitchen_start_at) {
    reasons.push('kitchen_start_at was never saved — dispatch job could not be scheduled.');
  } else if (!booking.kds_sent_at && new Date(booking.kitchen_start_at) > new Date()) {
    reasons.push(`Kitchen start is in the future (${booking.kitchen_start_at}). Check Future / scheduled strip.`);
  } else if (!booking.kds_sent_at) {
    reasons.push('Paid and past kitchen start, but kds_sent_at is still null — dispatch failed or not yet reconciled.');
  }
  if (booking.kds_sent_at && !kdsItems.length) {
    reasons.push('Marked dispatched (kds_sent_at set) but no kds_items found — notify may have failed partially.');
  }
  const active = kdsItems.filter((i) => ['pending', 'in_progress', 'ready'].includes(i.status));
  if (kdsItems.length && !active.length) {
    reasons.push('All KDS lines are completed/cancelled — check History tab.');
  }
  const readyOnly = active.filter((i) => i.status === 'ready');
  if (readyOnly.length === active.length && readyOnly.length) {
    reasons.push('Items are ready — Live board drops ready lines after ~20 minutes.');
  }
  if (!reasons.length) {
    reasons.push('Should be visible on Live orders if items are pending/cooking, or History if ready >20m.');
  }
  return reasons;
}

module.exports = {
  enqueueScheduledJobs,
  cancelScheduledJobsForBooking,
  cancelScheduledJobsForToken,
  syncScheduledJobsFromBookings,
  dispatchBookingToKds,
  reconcileMissedKdsDispatches,
  explainKdsVisibility,
  runDueScheduledJobs,
  runDueScheduledJobsForRestaurant,
};