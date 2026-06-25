// src/routes/tokens.js
// ============================================================================
// Walk-in token management
// Extracted from server.js (was inline app.* routes)
//
// POST   /api/tokens             Create token (walk-in desk / WA agent)
// GET    /api/tokens             List today's tokens for this outlet
// GET    /api/tokens/:id         Single token lookup
// PUT    /api/tokens/:id/assign  Seat customer at a table
// PUT    /api/tokens/:id/approve Approve large-party request
// PUT    /api/tokens/:id/reject  Reject large-party request
// DELETE /api/tokens/:id         Dismiss token
// PUT    /api/tokens/:id/complete Mark visit complete + free table
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabase, supabaseAdmin } = require('../config/supabase');
const { broadcastToRestaurant }   = require('../websocket');
const { sendWhatsAppMessage, sendWhatsAppCatalogWithSpecials, sendWhatsAppInteractive, isWhatsAppConfigured } = require('../helpers/whatsapp');
const { getOperationalAlertPhones } = require('../helpers/restaurantConfig');
const { sendOperationalAlerts } = require('../helpers/operationalAlerts');
const { validateScheduledDeliverySlot } = require('../helpers/deliverySlots');
const { assignAndNotifyCaptainTakeaway } = require('../helpers/captainAssignment');
const { syncConversationForTokenApproval, syncConversationForScheduledDeliveryApproval, syncConversationForScheduledTakeawayApproval } = require('../helpers/conversationState');
const { cancelScheduledJobsForBooking } = require('../helpers/scheduledJobs');
const { calculateWaitEstimate, buildDineInCustomerMessage } = require('../helpers/waitEstimate');
const { releaseTablesForToken } = require('../helpers/tableRelease');
const { writeAuditLog } = require('../helpers/auditLog');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');
const { requireKdsSecretOrJwt, requireKdsSecret } = require('../middleware/internalAuth');
const { getKdsSecret } = require('../config/internalSecret');
const { buildPortalTokenId, portalTokenMonthKey, parseMonthlyTokenId } = require('../helpers/portalTokens');

const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || 'http://localhost:8001';

/** Ask Python chat service to send Razorpay link after scheduled order approval. */
async function triggerChatScheduledPayment(restaurantId, token) {
  if (!token?.phone || !token?.id) return;
  try {
    const resp = await fetch(`${CHAT_SERVICE_URL}/internal/scheduled-approval-payment`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-internal-secret': getKdsSecret(),
      },
      body: JSON.stringify({ restaurant_id: restaurantId, token }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[scheduled-payment] chat trigger ${resp.status}: ${text.slice(0, 200)}`);
    } else {
      console.log(`[scheduled-payment] chat payment triggered for ${token.id}`);
    }
  } catch (err) {
    console.warn('[scheduled-payment] chat trigger failed (non-fatal):', err.message);
  }
}

/** Same outlet resolution as /api/tables (getRestaurantId + single-restaurant fallback). */
function requireOutlet(req, res, next) {
  if (!req.restaurant_id) {
    return res.status(401).json({ error: 'No restaurant assigned to this account' });
  }
  next();
}

const outletAuth = [authenticateToken, getRestaurantId, requireOutlet];

// ── generateTokenId ───────────────────────────────────────────────────────────
// Returns the next T-001 style sequential ID (collision-safe).

async function generateTokenId(restaurantId) {
  try {
    const { data: seq, error } = await supabaseAdmin.rpc('allocate_portal_token_seq', {
      p_restaurant_id: restaurantId,
    });
    if (!error && seq != null) {
      return buildPortalTokenId(seq);
    }
    if (error) {
      console.warn('[tokens] allocate_portal_token_seq RPC failed, using legacy max+1:', error.message);
    }
  } catch (err) {
    console.warn('[tokens] allocate_portal_token_seq unavailable, using legacy max+1:', err.message);
  }

  const yymm = portalTokenMonthKey();
  const { data: allTokens } = await supabaseAdmin
    .from('walk_in_tokens').select('id').eq('restaurant_id', restaurantId);

  let maxSeq = 0;
  for (const row of allTokens ?? []) {
    const monthly = parseMonthlyTokenId(row.id);
    if (monthly && monthly.yymm === yymm) {
      maxSeq = Math.max(maxSeq, monthly.seq);
      continue;
    }
    const legacy = String(row.id).match(/^T-(\d+)$/);
    if (legacy) maxSeq = Math.max(maxSeq, parseInt(legacy[1], 10));
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = buildPortalTokenId(maxSeq + 1 + attempt);
    const { data: existing } = await supabaseAdmin
      .from('walk_in_tokens').select('id').eq('id', candidate).maybeSingle();
    if (!existing) return candidate;
  }
  return `T-${yymm}-${Date.now().toString().slice(-6)}`;
}

/** One non-terminal visit per phone per day — idempotency for chat retries. */
function phoneLookupVariants(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return [];
  const variants = new Set([digits]);
  if (digits.length === 10) variants.add(`91${digits}`);
  if (digits.length > 10) variants.add(digits.slice(-10));
  if (digits.startsWith('91') && digits.length === 12) variants.add(digits.slice(2));
  return [...variants];
}

const SCHEDULED_TOKEN_TYPES = new Set(['scheduled_delivery', 'scheduled_takeaway']);

async function isLinkedBookingPaid(bookingId) {
  if (!bookingId) return false;
  const { data, error } = await supabaseAdmin
    .from('bookings')
    .select('payment_status, status')
    .eq('id', bookingId)
    .maybeSingle();
  if (error || !data) return false;
  return data.payment_status === 'paid' || data.status === 'confirmed';
}

async function findActiveTokenForPhone(restaurantId, phone) {
  const variants = phoneLookupVariants(phone);
  if (!variants.length) return null;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data, error } = await supabaseAdmin
    .from('walk_in_tokens')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .in('phone', variants)
    .in('status', ['waiting', 'pending_approval', 'seated', 'takeaway'])
    .gte('arrived_at', todayStart.toISOString())
    .order('arrived_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn('[tokens] findActiveTokenForPhone failed:', error.message);
    return null;
  }
  if (!data) return null;

  const meta = data.meta || {};
  const bookingId = meta.booking_id;
  if (bookingId && SCHEDULED_TOKEN_TYPES.has(data.type)) {
    if (await isLinkedBookingPaid(bookingId)) {
      return null;
    }
  }
  return data;
}

/** Cancel jobs and mark booking cancelled when a scheduled order is superseded. */
async function supersedeWalkInToken(token, restaurantId, reason) {
  const meta = token.meta || {};
  const { error } = await supabaseAdmin
    .from('walk_in_tokens')
    .update({
      status:       'completed',
      completed_at: new Date().toISOString(),
      meta: {
        ...meta,
        superseded_at:    new Date().toISOString(),
        supersede_reason: reason,
      },
    })
    .eq('id', token.id)
    .eq('restaurant_id', restaurantId);
  if (error) {
    console.warn(`[tokens] supersede ${token.id} failed:`, error.message);
    return;
  }
  if (meta.booking_id) {
    if (await isLinkedBookingPaid(meta.booking_id)) {
      console.warn(`[tokens] supersede skipped booking cancel — ${meta.booking_id} is paid`);
    } else {
      await cancelScheduledJobsForBooking(meta.booking_id);
      await supabaseAdmin.from('bookings')
        .update({ status: 'cancelled' })
        .eq('id', meta.booking_id);
    }
  }
  console.log(`[tokens] Superseded ${token.id} (${reason})`);
}

/**
 * Idempotent token reuse — only for true retries, not new orders.
 * Scheduled orders: reuse only when same booking_id is still pending_approval.
 * Otherwise supersede unpaid/stale scheduled tokens and allocate a new id.
 */
async function findReusableTokenForPhone(restaurantId, phone, type, meta = {}) {
  const existing = await findActiveTokenForPhone(restaurantId, phone);
  if (!existing) return null;

  if (SCHEDULED_TOKEN_TYPES.has(type)) {
    if (!SCHEDULED_TOKEN_TYPES.has(existing.type)) {
      // e.g. immediate takeaway active — do not block a new scheduled order
      return null;
    }

    const incomingBid = meta?.booking_id;
    const existingBid = existing.meta?.booking_id;

    if (
      incomingBid
      && existingBid === incomingBid
      && existing.status === 'pending_approval'
      && existing.type === type
    ) {
      const { data: updated, error } = await supabaseAdmin
        .from('walk_in_tokens')
        .update({ meta: { ...(existing.meta || {}), ...meta } })
        .eq('id', existing.id)
        .eq('restaurant_id', restaurantId)
        .select()
        .single();
      if (error) {
        console.warn(`[tokens] meta refresh for ${existing.id} failed:`, error.message);
        return { token: existing, deduplicated: true };
      }
      console.log(
        `[tokens] Refreshed pending token ${existing.id} for booking ${incomingBid} (retry)`,
      );
      return { token: updated, deduplicated: true };
    }

    if (existingBid && await isLinkedBookingPaid(existingBid)) {
      // Paid scheduled order — keep it; allocate a fresh token for the new booking
      return null;
    }

    // New booking or approved-but-unpaid prior order → retire old token
    await supersedeWalkInToken(existing, restaurantId, 'replaced_by_new_scheduled_order');
    return null;
  }

  // Immediate dine-in / takeaway / large_party: reuse same type only
  if (existing.type === type) {
    console.log(
      `[tokens] Reusing active token ${existing.id} for ${phone} ` +
      `(status=${existing.status}, deduplicated)`,
    );
    return { token: existing, deduplicated: true };
  }

  return null;
}

/** Approve scheduled_delivery only while status is pending_approval (single winner). */
async function approveScheduledDeliveryToken(tokenId, restaurantId, token) {
  const meta = token.meta || {};
  const { data: updatedToken, error } = await supabaseAdmin
    .from('walk_in_tokens')
    .update({
      status: 'takeaway',
      meta: { ...meta, approved_at: new Date().toISOString() },
    })
    .eq('id', tokenId)
    .eq('restaurant_id', restaurantId)
    .eq('status', 'pending_approval')
    .eq('type', 'scheduled_delivery')
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!updatedToken) {
    if (token.status === 'takeaway') {
      return { ok: true, token, alreadyApproved: true };
    }
    return { ok: false, statusCode: 409, error: 'Token already approved or rejected' };
  }

  if (meta.booking_id) {
    await supabaseAdmin.from('bookings')
      .update({ status: 'confirmed' })
      .eq('id', meta.booking_id);
  }

  if (token.phone && await isWhatsAppConfigured(restaurantId)) {
    const schedLabel = meta.scheduled_at_label || meta.scheduled_at || 'your chosen time';
    await sendWhatsAppMessage(
      token.phone,
      `✅ *Your scheduled delivery is approved!*\n\n`
      + `Token: *${token.id}*\n`
      + `Deliver by: *${schedLabel}*\n\n`
      + `We'll send your payment link shortly. You can also reply *PAY* here when ready.`,
      restaurantId
    );
  }

  await syncConversationForScheduledDeliveryApproval({
    restaurantId,
    customerPhone: token.phone,
    tokenId:       token.id,
    meta,
  });

  await triggerChatScheduledPayment(restaurantId, updatedToken);

  broadcastToRestaurant(restaurantId, {
    type: 'TOKEN_APPROVED', token: updatedToken, timestamp: new Date().toISOString(),
  });
  return { ok: true, token: updatedToken };
}

/** Reject scheduled_delivery only while status is pending_approval (single winner). */
async function rejectScheduledDeliveryToken(tokenId, restaurantId, token, reason) {
  const meta = token.meta || {};
  const { data: updatedToken, error } = await supabaseAdmin
    .from('walk_in_tokens')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      meta: {
        ...meta,
        rejected_at: new Date().toISOString(),
        ...(reason ? { rejection_reason: reason } : {}),
      },
    })
    .eq('id', tokenId)
    .eq('restaurant_id', restaurantId)
    .eq('status', 'pending_approval')
    .eq('type', 'scheduled_delivery')
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!updatedToken) {
    if (token.status === 'completed') {
      return { ok: true, token, alreadyRejected: true };
    }
    return { ok: false, statusCode: 409, error: 'Token already approved or rejected' };
  }

  if (meta.booking_id) {
    await cancelScheduledJobsForBooking(meta.booking_id);
    await supabaseAdmin.from('bookings')
      .update({ status: 'rejected' })
      .eq('id', meta.booking_id);
  }

  if (token.phone && await isWhatsAppConfigured(restaurantId)) {
    const reasonLine = reason ? `\n\nReason: ${reason}` : '';
    await sendWhatsAppMessage(
      token.phone,
      `😔 *We're unable to confirm your scheduled delivery right now.*${reasonLine}\n\n`
      + `Please try a different time or reply *Home* to see other options. 🙏`,
      restaurantId
    );
  }

  broadcastToRestaurant(restaurantId, {
    type: 'TOKEN_REJECTED', token: updatedToken, timestamp: new Date().toISOString(),
  });
  return { ok: true, token: updatedToken };
}

/** Approve scheduled_takeaway only while status is pending_approval (single winner). */
async function approveScheduledTakeawayToken(tokenId, restaurantId, token) {
  const meta = token.meta || {};
  const { data: updatedToken, error } = await supabaseAdmin
    .from('walk_in_tokens')
    .update({
      status: 'takeaway',
      meta: { ...meta, approved_at: new Date().toISOString() },
    })
    .eq('id', tokenId)
    .eq('restaurant_id', restaurantId)
    .eq('status', 'pending_approval')
    .eq('type', 'scheduled_takeaway')
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!updatedToken) {
    if (token.status === 'takeaway') {
      return { ok: true, token, alreadyApproved: true };
    }
    return { ok: false, statusCode: 409, error: 'Token already approved or rejected' };
  }

  if (meta.booking_id) {
    await supabaseAdmin.from('bookings')
      .update({ status: 'pending' })
      .eq('id', meta.booking_id);
  }

  if (token.phone && await isWhatsAppConfigured(restaurantId)) {
    const schedLabel = meta.scheduled_at_label || meta.scheduled_at || 'your chosen time';
    const kitchenLabel = meta.kitchen_start_at_label || meta.kitchen_start_at || '';
    await sendWhatsAppMessage(
      token.phone,
      `✅ *Your scheduled take-away is approved!*\n\n`
      + `Token: *${token.id}*\n`
      + `Pickup at: *${schedLabel}*\n`
      + (kitchenLabel ? `Kitchen starts: *${kitchenLabel}*\n\n` : '\n')
      + `We'll send your payment link shortly. You can also reply *PAY* here when ready.`,
      restaurantId
    );
  }

  await syncConversationForScheduledTakeawayApproval({
    restaurantId,
    customerPhone: token.phone,
    tokenId:       token.id,
    meta,
  });

  await triggerChatScheduledPayment(restaurantId, updatedToken);

  broadcastToRestaurant(restaurantId, {
    type: 'TOKEN_APPROVED', token: updatedToken, timestamp: new Date().toISOString(),
  });
  return { ok: true, token: updatedToken };
}

/** Reject scheduled_takeaway only while status is pending_approval (single winner). */
async function rejectScheduledTakeawayToken(tokenId, restaurantId, token, reason) {
  const meta = token.meta || {};
  const { data: updatedToken, error } = await supabaseAdmin
    .from('walk_in_tokens')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      meta: {
        ...meta,
        rejected_at: new Date().toISOString(),
        ...(reason ? { rejection_reason: reason } : {}),
      },
    })
    .eq('id', tokenId)
    .eq('restaurant_id', restaurantId)
    .eq('status', 'pending_approval')
    .eq('type', 'scheduled_takeaway')
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!updatedToken) {
    if (token.status === 'completed') {
      return { ok: true, token, alreadyRejected: true };
    }
    return { ok: false, statusCode: 409, error: 'Token already approved or rejected' };
  }

  if (meta.booking_id) {
    await cancelScheduledJobsForBooking(meta.booking_id);
    await supabaseAdmin.from('bookings')
      .update({ status: 'rejected' })
      .eq('id', meta.booking_id);
  }

  if (token.phone && await isWhatsAppConfigured(restaurantId)) {
    const reasonLine = reason ? `\n\nReason: ${reason}` : '';
    await sendWhatsAppMessage(
      token.phone,
      `😔 *We're unable to confirm your scheduled take-away right now.*${reasonLine}\n\n`
      + `Please try a different time or reply *Home* to see other options. 🙏`,
      restaurantId
    );
  }

  broadcastToRestaurant(restaurantId, {
    type: 'TOKEN_REJECTED', token: updatedToken, timestamp: new Date().toISOString(),
  });
  return { ok: true, token: updatedToken };
}

// ── POST /api/tokens ──────────────────────────────────────────────────────────

router.post('/', requireKdsSecretOrJwt, async (req, res) => {
  try {
    let { name, phone, type, pax, restaurant_id, meta } = req.body;

    // Manager portal JWT may omit restaurant_id — resolve like getRestaurantId
    if (!restaurant_id && req.user) {
      const { data: emp } = await supabaseAdmin
        .from('employees').select('restaurant_id').eq('id', req.user.sub).single();
      restaurant_id = emp?.restaurant_id ?? null;
      if (!restaurant_id) {
        const { data: restaurants } = await supabaseAdmin
          .from('restaurants').select('id').eq('is_active', true).limit(2);
        if (restaurants?.length === 1) restaurant_id = restaurants[0].id;
      }
    }

    if (!name?.trim())    return res.status(400).json({ error: 'name is required' });
    if (!type)            return res.status(400).json({ error: 'type is required' });
    if (!restaurant_id)   return res.status(400).json({ error: 'restaurant_id is required' });
    if (!['dinein', 'takeaway', 'large_party', 'scheduled_delivery', 'scheduled_takeaway'].includes(type))
      return res.status(400).json({ error: 'type must be dinein, takeaway, large_party, scheduled_delivery, or scheduled_takeaway' });

    if ((type === 'scheduled_delivery' || type === 'scheduled_takeaway') && meta?.scheduled_at) {
      const slotCheck = validateScheduledDeliverySlot(meta.scheduled_at);
      if (!slotCheck.valid) {
        return res.status(400).json({ error: slotCheck.message, reason: slotCheck.reason });
      }
    }

    const cleanPhone = phone ? String(phone).replace(/\D/g, '') : null;
    if (cleanPhone && ['dinein', 'large_party', 'takeaway', 'scheduled_delivery', 'scheduled_takeaway'].includes(type)) {
      const reuse = await findReusableTokenForPhone(restaurant_id, cleanPhone, type, meta || {});
      if (reuse) {
        return res.status(200).json({
          success: true,
          token: reuse.token,
          deduplicated: true,
        });
      }
    }

    const tokenId = await generateTokenId(restaurant_id);
    const status  = (type === 'large_party' || type === 'scheduled_delivery' || type === 'scheduled_takeaway') ? 'pending_approval'
                  : type === 'takeaway'    ? 'takeaway'
                  : 'waiting';

    const tokenRecord = {
      id:          tokenId,
      restaurant_id,
      name:        name.trim(),
      phone:       phone ? String(phone).replace(/\D/g, '') : null,
      type,
      pax:         (type === 'takeaway' || type === 'scheduled_delivery' || type === 'scheduled_takeaway') ? 1 : (parseInt(pax) || 1),
      status,
      arrived_at:  new Date().toISOString(),
      meta:        meta || {},
    };

    const { data: token, error: insertError } = await supabaseAdmin
      .from('walk_in_tokens').insert(tokenRecord).select().single();
    if (insertError) {
      const detail = insertError.message || String(insertError);
      if (detail.includes('walk_in_tokens_type_check')) {
        throw new Error(
          'Database migration required: run migrations/fix_walk_in_tokens_scheduled_delivery_check.sql '
          + 'in Supabase SQL editor (walk_in_tokens.type must allow scheduled_delivery)'
        );
      }
      throw insertError;
    }

    let finalToken = token;

    // Static wait estimate for dine-in queue tokens
    if (type === 'dinein' && status === 'waiting') {
      try {
        const partySize = parseInt(pax, 10) || 1;
        const estimate = await calculateWaitEstimate(
          supabaseAdmin,
          restaurant_id,
          partySize,
          token.arrived_at,
          token.id,
        );
        const { data: withEstimate, error: estErr } = await supabaseAdmin
          .from('walk_in_tokens')
          .update({
            capacity_requested:      partySize,
            estimated_wait_minutes:  estimate.estimate_minutes,
            waitlist_depth_at_issue: estimate.waitlist_depth,
            estimate_display:        estimate.display,
          })
          .eq('id', token.id)
          .select()
          .single();
        if (!estErr && withEstimate) {
          finalToken = withEstimate;
        }

        if (
          cleanPhone
          && req.body.customer_notify !== false
          && await isWhatsAppConfigured(restaurant_id)
        ) {
          await sendWhatsAppMessage(
            cleanPhone,
            buildDineInCustomerMessage(partySize, finalToken.id, estimate),
            restaurant_id,
          );
        }
      } catch (estExc) {
        console.warn('[tokens] wait estimate failed (non-fatal):', estExc.message);
      }
    }

    const arrivalTime = new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', year: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).replace(',', ', ');
    const portalUrl = `${process.env.FRONTEND_URL || 'https://app.autom8.works'}/dashboard/manager`;

    // notify=false skips the manager alert (e.g. duplicate guard). Default: send from API.
    const shouldNotify = req.query.notify !== 'false';
    if (shouldNotify && await isWhatsAppConfigured(restaurant_id)) {
      const alertPhones = await getOperationalAlertPhones(restaurant_id);
      if (alertPhones.length > 0) {
      if (type === 'large_party') {
        const combo      = meta?.combo ?? [];
        const tableLines = combo.length > 0
          ? combo.map(t => `Table ${t[0]} (${t[2]}/${t[1]} seats)`).join(' + ')
          : `${token.pax} seats`;
        sendOperationalAlerts(
          restaurant_id,
          `🟣 *Large Party Request* — Token *${token.id}*\n👥 ${token.name} · *${token.pax} people*\n🕐 ${arrivalTime} IST\n\nProposed: ${tableLines}\n\n⚠️ *Action required:*\n${portalUrl}`,
        );
      } else if (type === 'scheduled_delivery') {
        const schedAt = meta?.scheduled_at_label || meta?.scheduled_at || '—';
        const addr    = (meta?.delivery_address || '—').slice(0, 80);
        const total   = meta?.total != null ? `₹${Number(meta.total).toFixed(0)}` : '—';
        const body =
          `🛵 *Scheduled Door Delivery* — Token *${token.id}*\n` +
          `👤 ${token.name}\n📱 ${token.phone || '—'}\n` +
          `🕐 Delivery at: *${schedAt}*\n📍 ${addr}\n💰 ${total}\n\n` +
          `Order: ${(meta?.order_text || '—').slice(0, 120)}\n\n` +
          `Approve before the customer pays.`;
        const fallbackBody = `${body}\n\n⚠️ *Approve in portal before customer pays:*\n${portalUrl}`;
        sendOperationalAlerts(restaurant_id, fallbackBody, {
          interactive: {
            type: 'button',
            body: { text: body },
            footer: { text: 'Manager Portal — Pending approval' },
            action: {
              buttons: [
                { type: 'reply', reply: { id: `SCHED_APPROVE_${token.id}`, title: '✅ Approve' } },
                { type: 'reply', reply: { id: `SCHED_REJECT_${token.id}`, title: '❌ Reject' } },
              ],
            },
          },
        });
      } else if (type === 'scheduled_takeaway') {
        const schedAt = meta?.scheduled_at_label || meta?.scheduled_at || '—';
        const kitchenAt = meta?.kitchen_start_at_label || meta?.kitchen_start_at || '—';
        const total   = meta?.total != null ? `₹${Number(meta.total).toFixed(0)}` : '—';
        const body =
          `🥡 *Scheduled take-away* — Token *${token.id}*\n` +
          `👤 ${token.name}\n📱 ${token.phone || '—'}\n` +
          `🕐 Pickup at: *${schedAt}*\n👨‍🍳 Kitchen start: *${kitchenAt}*\n💰 ${total}\n\n` +
          `Order: ${(meta?.order_text || '—').slice(0, 120)}\n\n` +
          `Approve before the customer pays.`;
        const fallbackBody = `${body}\n\n⚠️ *Approve in portal before customer pays:*\n${portalUrl}`;
        sendOperationalAlerts(restaurant_id, fallbackBody, {
          interactive: {
            type: 'button',
            body: { text: body },
            footer: { text: 'Manager Portal — Pending approval' },
            action: {
              buttons: [
                { type: 'reply', reply: { id: `SCHED_APPROVE_${token.id}`, title: '✅ Approve' } },
                { type: 'reply', reply: { id: `SCHED_REJECT_${token.id}`, title: '❌ Reject' } },
              ],
            },
          },
        });
      } else if (type === 'dinein') {
        sendOperationalAlerts(
          restaurant_id,
          `🪑 *New Walk-in* — Token *${token.id}*\n` +
          `👤 ${token.name}, ${token.pax} ${token.pax === 1 ? 'person' : 'people'}\n` +
          `🍽️ Dine-in\n🕐 ${arrivalTime} IST\n\n` +
          `Open portal to assign table:\n${portalUrl}`,
        );
      } else {
        sendOperationalAlerts(
          restaurant_id,
          `🪑 *New Walk-in* — Token *${token.id}*\n👤 ${token.name}\n📦 Takeaway\n🕐 ${arrivalTime} IST\n\n${portalUrl}`,
        );
      }
      }
    }

    broadcastToRestaurant(restaurant_id, {
      type:        'TOKEN_NEW',
      token_id:    finalToken.id,
      token:       finalToken,
      timestamp:   new Date().toISOString(),
    });
    res.status(201).json({ success: true, token: finalToken });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to create token' });
  }
});

// ── POST /api/tokens/manager-order-alert — internal: same WA path as walk-in alerts ─

router.post('/manager-order-alert', requireKdsSecret, async (req, res) => {
  try {
    const {
      restaurant_id,
      token_number,
      customer_name,
      customer_phone,
      order_text,
      total,
      table_number,
      party_size,
      booking_time,
      service_type,
    } = req.body;

    if (!restaurant_id || !token_number) {
      return res.status(400).json({ error: 'restaurant_id and token_number are required' });
    }

    const isTakeaway = service_type === 'takeaway';
    const header = isTakeaway ? '📋 Order Received — Takeaway' : '📋 Order Received — Dine-in';
    const tablesLabel = isTakeaway ? 'Takeaway / Counter' : (table_number ?? 'Multi-table / TBD');
    const guestsLine = isTakeaway ? '' : `Guests: ${party_size ?? '—'}\n`;
    const body =
      `${header}\n────────────────────\n` +
      `Token: ${token_number}\nCustomer: ${customer_name || 'Guest'}\n` +
      `Phone: ${customer_phone || '—'}\nTable: ${tablesLabel}\n` +
      guestsLine +
      `Booking Time: ${booking_time || '—'}\n` +
      `Order: ${order_text || '—'}\nTotal: ₹${Number(total || 0).toFixed(0)}\n` +
      `────────────────────`;

    const { sent, phones } = await sendOperationalAlerts(restaurant_id, body);
    if (!sent) {
      console.warn(`[manager-order-alert] No manager alert phones for restaurant ${restaurant_id}`);
      return res.status(400).json({ error: 'No manager alert phones configured' });
    }
    console.log(`[manager-order-alert] ✅ ${token_number} → ${phones.join(', ')}`);
    return res.json({ success: true, phones, sent });
  } catch (err) {
    console.error('[manager-order-alert]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/tokens/captain-takeaway-alert — internal: auto-assign + notify captain ─

router.post('/captain-takeaway-alert', requireKdsSecret, async (req, res) => {
  try {
    const {
      restaurant_id,
      token_number,
      customer_name,
      customer_phone,
      order_text,
      total,
      booking_time,
    } = req.body;

    if (!restaurant_id || !token_number) {
      return res.status(400).json({ error: 'restaurant_id and token_number are required' });
    }

    const result = await assignAndNotifyCaptainTakeaway({
      restaurantId:   restaurant_id,
      tokenNumber:    token_number,
      customerName:   customer_name,
      customerPhone:  customer_phone,
      orderText:      order_text,
      total,
      bookingTime:    booking_time,
    });

    if (!result.assigned) {
      console.warn(`[captain-takeaway-alert] No captain assigned for ${token_number}`);
      return res.json({
        success:      true,
        assigned:     false,
        notified:     false,
        captain_name: null,
      });
    }

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[captain-takeaway-alert]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/tokens/rebroadcast — internal: WS notify after chat DB fallback ─

router.post('/rebroadcast', requireKdsSecret, async (req, res) => {
  try {
    const { restaurant_id, token_id } = req.body;
    if (!restaurant_id || !token_id) {
      return res.status(400).json({ error: 'restaurant_id and token_id are required' });
    }

    const { data: token, error } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('*')
      .eq('id', token_id)
      .eq('restaurant_id', restaurant_id)
      .maybeSingle();

    if (error) throw error;
    if (!token) return res.status(404).json({ error: 'Token not found for this outlet' });

    broadcastToRestaurant(restaurant_id, {
      type:      'TOKEN_NEW',
      token_id:  token.id,
      token,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tokens ───────────────────────────────────────────────────────────

router.get('/', outletAuth, async (req, res) => {
  try {
    const restaurantId = req.restaurant_id;
    const { status } = req.query;

    let query = supabaseAdmin
      .from('walk_in_tokens').select('*')
      .eq('restaurant_id', restaurantId)
      .order('arrived_at', { ascending: true });

    if (status) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      query = query.eq('status', status).gte('arrived_at', todayStart.toISOString());
    } else {
      // Include all pending approvals (future scheduled deliveries may sit for days).
      query = query.in('status', ['waiting', 'seated', 'takeaway', 'pending_approval']);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, tokens: data || [] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/tokens/lookup — internal: chat agent table assignment poll ───────

router.get('/lookup', requireKdsSecret, async (req, res) => {
  try {
    const { phone, restaurant_id } = req.query;
    if (!phone || !restaurant_id) {
      return res.status(400).json({ error: 'phone and restaurant_id are required' });
    }

    const cleanPhone = String(phone).replace(/\D/g, '');
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data, error } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('id, table_number, status, type, name, phone, pax, meta, arrived_at, seated_at')
      .eq('restaurant_id', restaurant_id)
      .eq('phone', cleanPhone)
      .in('status', ['waiting', 'seated', 'takeaway', 'pending_approval'])
      .gte('arrived_at', todayStart.toISOString())
      .order('arrived_at', { ascending: false })
      .limit(5);

    if (error) throw error;
    res.json({ success: true, tokens: data ?? [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tokens/approvals/history — past approval decisions ───────────────

router.get('/approvals/history', outletAuth, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner', 'brand_manager'].includes(req.user_role)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const restaurantId = req.restaurant_id;
    const fromStr = String(req.query.from || '').slice(0, 10);
    const toStr = String(req.query.to || '').slice(0, 10);
    if (!fromStr || !toStr) {
      return res.status(400).json({ error: 'from and to query params required (YYYY-MM-DD)' });
    }

    const fromMs = new Date(`${fromStr}T00:00:00+05:30`).getTime();
    const toMs = new Date(`${toStr}T23:59:59.999+05:30`).getTime();
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      return res.status(400).json({ error: 'Invalid from/to date' });
    }

    const lookbackStart = new Date(fromMs - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .in('type', ['large_party', 'scheduled_takeaway', 'scheduled_delivery'])
      .gte('arrived_at', lookbackStart)
      .order('arrived_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    const decisionAt = (token) => {
      const meta = token.meta || {};
      return meta.approved_at || meta.rejected_at || token.completed_at || null;
    };

    const history = (data ?? [])
      .map((token) => {
        const meta = token.meta || {};
        const decidedAt = decisionAt(token);
        const approved = Boolean(meta.approved_at) || (token.type === 'large_party' && token.status === 'seated');
        const rejected = Boolean(meta.rejected_at) || (token.status === 'completed' && !meta.approved_at);
        let decision = 'pending';
        if (approved && !rejected) decision = 'approved';
        else if (rejected) decision = 'rejected';
        else if (token.status === 'pending_approval') decision = 'pending';

        return {
          token_id: token.id,
          type: token.type,
          name: token.name,
          phone: token.phone,
          pax: token.pax,
          status: token.status,
          decision,
          decided_at: decidedAt,
          arrived_at: token.arrived_at,
          scheduled_at_label: meta.scheduled_at_label || meta.scheduled_at || null,
          kitchen_start_label: meta.kitchen_start_at_label || null,
          delivery_address: meta.delivery_address || null,
          order_preview: (meta.order_text || '').slice(0, 200),
          total: meta.total ?? null,
          rejection_reason: meta.rejection_reason || null,
          table_split: meta.combo || null,
        };
      })
      .filter((row) => {
        if (row.decision === 'pending') return false;
        if (!row.decided_at) return false;
        const t = new Date(row.decided_at).getTime();
        return t >= fromMs && t <= toMs;
      })
      .sort((a, b) => new Date(b.decided_at) - new Date(a.decided_at));

    res.json({
      success: true,
      from: fromStr,
      to: toStr,
      count: history.length,
      history,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/tokens/:id ───────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('id, name, phone, status, type, pax, table_number, table_id, arrived_at, seated_at')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Token not found' });
    res.json({ success: true, token: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/tokens/:id/assign ────────────────────────────────────────────────

router.put('/:id/assign', outletAuth, async (req, res) => {
  try {
    const restaurantId = req.restaurant_id;

    const { table_id, table_number } = req.body;
    if (!table_id || !table_number) return res.status(400).json({ error: 'table_id and table_number required' });

    const { data: token, error: fetchError } = await supabaseAdmin
      .from('walk_in_tokens').select('*')
      .eq('id', req.params.id).eq('restaurant_id', restaurantId).single();
    if (fetchError || !token) return res.status(404).json({ error: 'Token not found' });
    if (token.status !== 'waiting') return res.status(400).json({ error: `Token is already ${token.status}` });

    const { data: updatedToken, error: updateError } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({ status: 'seated', table_id, table_number, seated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('restaurant_id', restaurantId)
      .select().single();
    if (updateError) throw updateError;

    await supabaseAdmin.from('tables').update({
      status: 'occupied',
      seated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', table_id).eq('restaurant_id', restaurantId);

    let menuSendResult = {};
    if (token.phone && await isWhatsAppConfigured(restaurantId)) {
      await sendWhatsAppMessage(
        token.phone,
        `✅ *Your table is ready!*\n\nToken: *${token.id}*\nTable: *Table ${table_number}*\n\nPlease proceed to your table. Enjoy! 🍽️`,
        restaurantId
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      menuSendResult = await sendWhatsAppCatalogWithSpecials(token.phone, restaurantId);
    }

    await syncConversationForTokenApproval({
      restaurantId,
      customerPhone: token.phone,
      tokenId:       token.id,
      tableNumbers:  [String(table_number)],
      partySize:     token.pax,
      specialsNoteSent: menuSendResult.specialsSent,
      menuSendResult,
    });

    broadcastToRestaurant(restaurantId, { type: 'TOKEN_ASSIGNED', token: updatedToken, timestamp: new Date().toISOString() });

    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: restaurantId,
      action: 'Token assigned to table', details: { token_id: req.params.id, table_id, table_number },
    });

    res.json({ success: true, token: updatedToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/tokens/:id/approve ───────────────────────────────────────────────

router.put('/:id/approve', outletAuth, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner', 'brand_manager'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });
    const restaurantId = req.restaurant_id;

    const { data: token } = await supabaseAdmin
      .from('walk_in_tokens').select('*').eq('id', req.params.id).eq('restaurant_id', restaurantId).single();
    if (!token) return res.status(404).json({ error: 'Token not found' });
    if (token.status !== 'pending_approval') return res.status(400).json({ error: `Token is ${token.status}` });

    // ── Scheduled delivery: approve before customer payment ─────────────────
    if (token.type === 'scheduled_delivery') {
      const result = await approveScheduledDeliveryToken(req.params.id, restaurantId, token);
      if (!result.ok) {
        return res.status(result.statusCode || 400).json({ error: result.error });
      }
      await writeAuditLog({
        user_id: req.user.sub, restaurant_id: restaurantId,
        action: 'Scheduled delivery approved',
        details: { token_id: req.params.id, customer: token.name },
      });
      return res.json({ success: true, token: result.token });
    }

    if (token.type === 'scheduled_takeaway') {
      const result = await approveScheduledTakeawayToken(req.params.id, restaurantId, token);
      if (!result.ok) {
        return res.status(result.statusCode || 400).json({ error: result.error });
      }
      await writeAuditLog({
        user_id: req.user.sub, restaurant_id: restaurantId,
        action: 'Scheduled takeaway approved',
        details: { token_id: req.params.id, customer: token.name },
      });
      return res.json({ success: true, token: result.token });
    }

    const combo        = token.meta?.combo ?? [];
    const tableNumbers = combo.map(t => String(t[0]));
    let tableIds       = [];
    if (tableNumbers.length > 0) {
      const { data: tableRows } = await supabaseAdmin
        .from('tables').select('id, table_number').eq('restaurant_id', restaurantId).in('table_number', tableNumbers);
      tableIds = (tableRows ?? []).map(t => t.id);
    }

    const { data: updatedToken } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({
        status: 'seated',
        table_id: tableIds[0] ?? null,
        table_number: tableNumbers[0] ?? null,
        seated_at: new Date().toISOString(),
        meta: {
          ...(token.meta || {}),
          approved_at: new Date().toISOString(),
          table_ids: tableIds,
          table_numbers: tableNumbers,
        },
      })
      .eq('id', req.params.id).select().single();

    if (tableIds.length > 0) {
      const seatedAt = new Date().toISOString();
      await supabaseAdmin.from('tables').update({
        status: 'occupied',
        seated_at: seatedAt,
        updated_at: seatedAt,
      }).in('id', tableIds).eq('restaurant_id', restaurantId);
    }

    let menuSendResult = {};
    if (token.phone && await isWhatsAppConfigured(restaurantId)) {
      await sendWhatsAppMessage(
        token.phone,
        `✅ *Your table arrangement has been confirmed.*\n\nToken: *${token.id}*\nParty of: *${token.pax} people*\nTables: *${tableNumbers.join(', ')}*\n\nPlease head to the restaurant! 🍽️`,
        restaurantId
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      menuSendResult = await sendWhatsAppCatalogWithSpecials(token.phone, restaurantId);
    }

    await syncConversationForTokenApproval({
      restaurantId,
      customerPhone: token.phone,
      tokenId:       token.id,
      tableNumbers,
      partySize:     token.pax,
      specialsNoteSent: menuSendResult.specialsSent,
      menuSendResult,
    });

    broadcastToRestaurant(restaurantId, { type: 'TOKEN_APPROVED', token: updatedToken, timestamp: new Date().toISOString() });
    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: restaurantId,
      action: 'Large party approved',
      details: { token_id: req.params.id, customer: token.name, pax: token.pax, tables: tableNumbers },
    });
    res.json({ success: true, token: updatedToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/tokens/:id/reject ────────────────────────────────────────────────

router.put('/:id/reject', outletAuth, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner', 'brand_manager'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const restaurantId = req.restaurant_id;
    const { data: token } = await supabaseAdmin
      .from('walk_in_tokens').select('*').eq('id', req.params.id).eq('restaurant_id', restaurantId).single();
    if (!token) return res.status(404).json({ error: 'Token not found' });

    if (token.type === 'scheduled_delivery') {
      const result = await rejectScheduledDeliveryToken(
        req.params.id, restaurantId, token, req.body.reason,
      );
      if (!result.ok) {
        return res.status(result.statusCode || 400).json({ error: result.error });
      }
      await writeAuditLog({
        user_id: req.user.sub, restaurant_id: restaurantId,
        action: 'Scheduled delivery rejected',
        details: { token_id: req.params.id, reason: req.body.reason || null },
      });
      return res.json({ success: true, token: result.token });
    }

    if (token.type === 'scheduled_takeaway') {
      const result = await rejectScheduledTakeawayToken(
        req.params.id, restaurantId, token, req.body.reason,
      );
      if (!result.ok) {
        return res.status(result.statusCode || 400).json({ error: result.error });
      }
      await writeAuditLog({
        user_id: req.user.sub, restaurant_id: restaurantId,
        action: 'Scheduled takeaway rejected',
        details: { token_id: req.params.id, reason: req.body.reason || null },
      });
      return res.json({ success: true, token: result.token });
    }

    if (token.status !== 'pending_approval') {
      return res.status(409).json({ error: `Token is ${token.status}` });
    }

    const { data: updatedToken } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        meta: {
          ...(token.meta || {}),
          rejected_at: new Date().toISOString(),
          ...(req.body.reason ? { rejection_reason: req.body.reason } : {}),
        },
      })
      .eq('id', req.params.id)
      .eq('status', 'pending_approval')
      .select()
      .maybeSingle();

    if (!updatedToken) {
      return res.status(409).json({ error: 'Token already approved or rejected' });
    }

    if (token.phone && await isWhatsAppConfigured(restaurantId)) {
      const reasonLine = req.body.reason ? `\n\nReason: ${req.body.reason}` : '';
      await sendWhatsAppMessage(
        token.phone,
        `😔 *We're unable to accommodate your party of ${token.pax} right now.*${reasonLine}\n\nReply *RESERVE* to book for a future date. 🙏`,
        restaurantId
      );
    }

    broadcastToRestaurant(restaurantId, { type: 'TOKEN_REJECTED', token: updatedToken, timestamp: new Date().toISOString() });
    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: restaurantId,
      action: 'Large party rejected',
      details: { token_id: req.params.id, reason: req.body.reason || null },
    });
    res.json({ success: true, token: updatedToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/tokens/:id/complete ──────────────────────────────────────────────

router.put('/:id/complete', outletAuth, async (req, res) => {
  try {
    const restaurantId = req.restaurant_id;

    const { data: token } = await supabaseAdmin
      .from('walk_in_tokens').select('*').eq('id', req.params.id).eq('restaurant_id', restaurantId).single();
    if (!token) return res.status(404).json({ error: 'Token not found' });

    const { data: updatedToken } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();

    if (token.phone) {
      const digits = String(token.phone).replace(/\D/g, '');
      const variants = [digits];
      if (digits.length === 10) variants.push(`91${digits}`);
      if (digits.length > 10) variants.push(digits.slice(-10));
      await supabaseAdmin
        .from('orders')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('restaurant_id', restaurantId)
        .in('customer_phone', variants)
        .eq('status', 'ready');
    }

    await releaseTablesForToken(supabaseAdmin, token, restaurantId, {
      queueFeedback: true,
      feedbackSource: 'token-complete',
    });

    broadcastToRestaurant(restaurantId, { type: 'TOKEN_COMPLETED', token: updatedToken, timestamp: new Date().toISOString() });
    res.json({ success: true, token: updatedToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/tokens/:id/approve-internal — chat agent: manager WhatsApp approve ─

router.post('/:id/approve-internal', requireKdsSecret, async (req, res) => {
  try {
    const restaurantId = req.body.restaurant_id;
    if (!restaurantId) return res.status(400).json({ error: 'restaurant_id is required' });

    const { data: token } = await supabaseAdmin
      .from('walk_in_tokens').select('*').eq('id', req.params.id).eq('restaurant_id', restaurantId).single();
    if (!token) return res.status(404).json({ error: 'Token not found' });
    if (token.type === 'scheduled_delivery') {
      const result = await approveScheduledDeliveryToken(req.params.id, restaurantId, token);
      if (!result.ok) {
        return res.status(result.statusCode || 400).json({ error: result.error });
      }
      return res.json({ success: true, token: result.token });
    }
    if (token.type === 'scheduled_takeaway') {
      const result = await approveScheduledTakeawayToken(req.params.id, restaurantId, token);
      if (!result.ok) {
        return res.status(result.statusCode || 400).json({ error: result.error });
      }
      return res.json({ success: true, token: result.token });
    }
    return res.status(400).json({ error: 'Internal approve supports scheduled_delivery and scheduled_takeaway only' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/tokens/:id/reject-internal — chat agent: manager WhatsApp reject ─

router.post('/:id/reject-internal', requireKdsSecret, async (req, res) => {
  try {
    const restaurantId = req.body.restaurant_id;
    if (!restaurantId) return res.status(400).json({ error: 'restaurant_id is required' });

    const { data: token } = await supabaseAdmin
      .from('walk_in_tokens').select('*').eq('id', req.params.id).eq('restaurant_id', restaurantId).single();
    if (!token) return res.status(404).json({ error: 'Token not found' });
    if (token.type === 'scheduled_delivery') {
      const result = await rejectScheduledDeliveryToken(
        req.params.id, restaurantId, token, req.body.reason,
      );
      if (!result.ok) {
        return res.status(result.statusCode || 400).json({ error: result.error });
      }
      return res.json({ success: true, token: result.token });
    }
    if (token.type === 'scheduled_takeaway') {
      const result = await rejectScheduledTakeawayToken(
        req.params.id, restaurantId, token, req.body.reason,
      );
      if (!result.ok) {
        return res.status(result.statusCode || 400).json({ error: result.error });
      }
      return res.json({ success: true, token: result.token });
    }
    return res.status(400).json({ error: 'Internal reject supports scheduled_delivery and scheduled_takeaway only' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/tokens/:id ────────────────────────────────────────────────────

router.delete('/:id', outletAuth, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('walk_in_tokens').delete().eq('id', req.params.id).eq('restaurant_id', req.restaurant_id);
    if (error) throw error;
    res.json({ success: true, message: 'Token dismissed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
