'use strict';

const { supabase, supabaseAdmin } = require('../../config/supabase');
const { broadcastToRestaurant }   = require('../../websocket');
const { sendWhatsAppMessage, sendWhatsAppCatalogWithSpecials, sendWhatsAppInteractive, isWhatsAppConfigured } = require('../../helpers/whatsapp');
const { getOperationalAlertPhones } = require('../../helpers/restaurantConfig');
const { sendOperationalAlerts } = require('../../helpers/operationalAlerts');
const { validateScheduledDeliverySlot } = require('../../helpers/deliverySlots');
const { assignAndNotifyCaptainTakeaway } = require('../../helpers/captainAssignment');
const { syncConversationForTokenApproval, syncConversationForScheduledDeliveryApproval, syncConversationForScheduledTakeawayApproval } = require('../../helpers/conversationState');
const { cancelScheduledJobsForBooking } = require('../../helpers/scheduledJobs');
const { calculateWaitEstimate, buildDineInCustomerMessage } = require('../../helpers/waitEstimate');
const { releaseTablesForToken } = require('../../helpers/tableRelease');
const { writeAuditLog } = require('../../helpers/auditLog');
const { authenticateToken, getRestaurantId } = require('../../middleware/auth');
const { requireKdsSecretOrJwt, requireKdsSecret } = require('../../middleware/internalAuth');
const { getKdsSecret } = require('../../config/internalSecret');
const { buildPortalTokenId, portalTokenMonthKey, parseMonthlyTokenId } = require('../../helpers/portalTokens');
const { fetchAvailableTables, pickTableCombo } = require('../../helpers/dineInAutoAssign');

const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || 'http://localhost:8001';
const LARGE_PARTY_THRESHOLD = 8;

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
// Returns the next T-YYMM-001 style sequential ID (collision-safe).
//
// Allocation order:
//   1. Fast path: allocate_portal_token_seq() RPC — atomic single UPDATE...RETURNING
//      on the restaurants row, safe under concurrency by Postgres row-lock semantics.
//   2. Fallback: allocate_portal_token_seq_legacy_locked() RPC — advisory-locked scan,
//      shared with the Python chat service's fallback so both services serialize
//      against the same Postgres lock instead of independently racing each other.
//   3. Last-resort: timestamp-suffixed id, logged as an error (should never happen
//      once step 1 or 2 succeeds).

async function generateTokenId(restaurantId) {
  try {
    const { data: seq, error } = await supabaseAdmin.rpc('allocate_portal_token_seq', {
      p_restaurant_id: restaurantId,
    });
    if (!error && seq != null) {
      const tokenId = buildPortalTokenId(seq);
      console.log(`[token-alloc] rpc seq=${seq} -> ${tokenId} restaurant=${restaurantId}`);
      return tokenId;
    }
    if (error) {
      console.warn('[token-alloc] fast RPC (allocate_portal_token_seq) failed, using locked fallback:', error.message);
    }
  } catch (err) {
    console.warn('[token-alloc] fast RPC (allocate_portal_token_seq) unavailable, using locked fallback:', err.message);
  }

  // Cross-process-safe fallback — same SQL function the Python chat service calls
  // (tools/db_tools.py::_next_portal_token_id), so Node and Python serialize
  // against one shared Postgres advisory lock instead of racing each other.
  try {
    const { data: lockedId, error: lockedErr } = await supabaseAdmin.rpc(
      'allocate_portal_token_seq_legacy_locked',
      { p_restaurant_id: restaurantId },
    );
    if (!lockedErr && lockedId) {
      console.warn(`[token-alloc] locked-fallback id=${lockedId} restaurant=${restaurantId}`);
      return lockedId;
    }
    if (lockedErr) {
      console.error('[token-alloc] locked fallback RPC failed:', lockedErr.message);
    }
  } catch (err) {
    console.error('[token-alloc] locked fallback RPC threw:', err.message);
  }

  console.error(
    `[token-alloc] BOTH allocation paths failed for restaurant=${restaurantId} — ` +
    `falling back to timestamp id. This should be investigated; run migrations/` +
    `20260703_token_seq_locked_fallback.sql if allocate_portal_token_seq_legacy_locked ` +
    `is missing.`
  );
  const yymm = portalTokenMonthKey();
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

  // Immediate flows: always allocate a fresh sequential token.
  // Reuse by phone/type caused duplicate token labels across distinct orders.
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
    // Keep pending until payment succeeds — confirming here made fulfill_from_webhook
    // skip the deferred-KDS path and push live tickets immediately.
    await supabaseAdmin.from('bookings')
      .update({ status: 'pending' })
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

  console.log(`[token-approval] scheduled_delivery token=${token.id} restaurant=${restaurantId} approved -> status=takeaway`);
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

  console.log(`[token-approval] scheduled_takeaway token=${token.id} restaurant=${restaurantId} approved -> status=takeaway`);
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

module.exports = {
  supabase,
  supabaseAdmin,
  broadcastToRestaurant,
  sendWhatsAppMessage,
  sendWhatsAppCatalogWithSpecials,
  sendWhatsAppInteractive,
  isWhatsAppConfigured,
  getOperationalAlertPhones,
  sendOperationalAlerts,
  validateScheduledDeliverySlot,
  assignAndNotifyCaptainTakeaway,
  syncConversationForTokenApproval,
  syncConversationForScheduledDeliveryApproval,
  syncConversationForScheduledTakeawayApproval,
  cancelScheduledJobsForBooking,
  calculateWaitEstimate,
  buildDineInCustomerMessage,
  releaseTablesForToken,
  writeAuditLog,
  authenticateToken,
  getRestaurantId,
  requireKdsSecretOrJwt,
  requireKdsSecret,
  getKdsSecret,
  buildPortalTokenId,
  portalTokenMonthKey,
  parseMonthlyTokenId,
  fetchAvailableTables,
  pickTableCombo,
  CHAT_SERVICE_URL,
  LARGE_PARTY_THRESHOLD,
  triggerChatScheduledPayment,
  requireOutlet,
  outletAuth,
  generateTokenId,
  phoneLookupVariants,
  isLinkedBookingPaid,
  findActiveTokenForPhone,
  supersedeWalkInToken,
  findReusableTokenForPhone,
  approveScheduledDeliveryToken,
  rejectScheduledDeliveryToken,
  approveScheduledTakeawayToken,
  rejectScheduledTakeawayToken,
};
