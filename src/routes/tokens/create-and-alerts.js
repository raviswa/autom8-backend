'use strict';

const express = require('express');
const router  = express.Router();
const {
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
} = require('./shared');

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
          .from('tenants').select('id').eq('is_active', true).limit(2);
        if (restaurants?.length === 1) restaurant_id = restaurants[0].id;
      }
    }

    if (!name?.trim())    return res.status(400).json({ error: 'name is required' });
    if (!type)            return res.status(400).json({ error: 'type is required' });
    if (!restaurant_id)   return res.status(400).json({ error: 'restaurant_id is required' });
    if (!['dinein', 'takeaway', 'queue', 'large_party', 'scheduled_delivery', 'scheduled_takeaway'].includes(type))
      return res.status(400).json({ error: 'type must be dinein, takeaway, queue, large_party, scheduled_delivery, or scheduled_takeaway' });

    if ((type === 'scheduled_delivery' || type === 'scheduled_takeaway') && meta?.scheduled_at) {
      const slotCheck = validateScheduledDeliverySlot(meta.scheduled_at);
      if (!slotCheck.valid) {
        return res.status(400).json({ error: slotCheck.message, reason: slotCheck.reason });
      }
    }

    const cleanPhone = phone ? String(phone).replace(/\D/g, '') : null;
    if (cleanPhone && ['dinein', 'queue', 'large_party', 'takeaway', 'scheduled_delivery', 'scheduled_takeaway'].includes(type)) {
      const reuse = await findReusableTokenForPhone(restaurant_id, cleanPhone, type, meta || {});
      if (reuse) {
        return res.status(200).json({
          success: true,
          token: reuse.token,
          deduplicated: true,
        });
      }
    }

    const partySize = (type === 'takeaway' || type === 'scheduled_delivery' || type === 'scheduled_takeaway')
      ? 1
      : (parseInt(pax, 10) || 1);

    // Manager walk-in sends type=dinein; large parties need multi-table combo + approval flow.
    // type=queue is Token/Queue handoff — never auto-promoted to large_party.
    let resolvedType = type;
    let resolvedMeta = { ...(meta || {}) };
    if (resolvedType === 'dinein' && partySize > LARGE_PARTY_THRESHOLD) {
      resolvedType = 'large_party';
    }
    if (resolvedType === 'large_party' && !Array.isArray(resolvedMeta.combo)) {
      try {
        const availTables = await fetchAvailableTables(restaurant_id);
        const combo = pickTableCombo(availTables, partySize);
        if (combo) resolvedMeta.combo = combo;
      } catch (comboErr) {
        console.warn('[tokens] large-party combo lookup failed (non-fatal):', comboErr.message);
      }
    }

    const tokenId = await generateTokenId(restaurant_id);
    const status  = (resolvedType === 'large_party' || resolvedType === 'scheduled_delivery' || resolvedType === 'scheduled_takeaway') ? 'pending_approval'
                  : resolvedType === 'takeaway'    ? 'takeaway'
                  : 'waiting';

    const tokenRecord = {
      id:          tokenId,
      restaurant_id,
      name:        name.trim(),
      phone:       phone ? String(phone).replace(/\D/g, '') : null,
      type:        resolvedType,
      pax:         partySize,
      status,
      arrived_at:  new Date().toISOString(),
      meta:        resolvedMeta,
    };

    // Defense in depth: even though generateTokenId() should now be collision-free,
    // guard the insert itself against a PK conflict rather than letting it 500.
    let { data: token, error: insertError } = await supabaseAdmin
      .from('walk_in_tokens').insert(tokenRecord).select().single();

    if (insertError && String(insertError.message || '').includes('duplicate key')) {
      console.error(
        `[token-alloc] PK COLLISION on insert for id=${tokenId} restaurant=${restaurant_id} — ` +
        `this should not happen post-fix; retrying allocation once.`
      );
      tokenRecord.id = await generateTokenId(restaurant_id);
      ({ data: token, error: insertError } = await supabaseAdmin
        .from('walk_in_tokens').insert(tokenRecord).select().single());
    }

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
    if (resolvedType === 'dinein' && status === 'waiting') {
      try {
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
    // Staff JWT walk-ins skip manager WA alerts — they are already in the portal.
    const shouldNotify = req.query.notify !== 'false' && !req.user;
    if (shouldNotify && await isWhatsAppConfigured(restaurant_id)) {
      const alertPhones = await getOperationalAlertPhones(restaurant_id);
      if (alertPhones.length > 0) {
      if (resolvedType === 'large_party') {
        const combo      = resolvedMeta?.combo ?? [];
        const tableLines = combo.length > 0
          ? combo.map(t => `Table ${t[0]} (${t[2]}/${t[1]} seats)`).join(' + ')
          : `${token.pax} seats`;
        sendOperationalAlerts(
          restaurant_id,
          `🟣 *Large Party Request* — Token *${token.id}*\n👥 ${token.name} · *${token.pax} people*\n🕐 ${arrivalTime} IST\n\nProposed: ${tableLines}\n\n⚠️ *Action required:*\n${portalUrl}`,
        );
      } else if (resolvedType === 'scheduled_delivery') {
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
      } else if (resolvedType === 'scheduled_takeaway') {
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
      } else if (resolvedType === 'queue') {
        sendOperationalAlerts(
          restaurant_id,
          `🎫 *New Queue Token* — *${token.id}*\n` +
          `👤 ${token.name}, ${token.pax} ${token.pax === 1 ? 'person' : 'people'}\n` +
          `🕐 ${arrivalTime} IST\n\n` +
          `Please assist at the counter:\n${portalUrl}`,
        );
      } else if (resolvedType === 'dinein') {
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

module.exports = router;
