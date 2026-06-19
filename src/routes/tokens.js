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
const { sendWhatsAppMessage, sendWhatsAppCatalogWithSpecials, sendWhatsAppInteractive } = require('../helpers/whatsapp');
const { getManagerPhone } = require('../helpers/restaurantConfig');
const { validateScheduledDeliverySlot } = require('../helpers/deliverySlots');
const { assignAndNotifyCaptainTakeaway } = require('../helpers/captainAssignment');
const { syncConversationForTokenApproval, syncConversationForScheduledDeliveryApproval } = require('../helpers/conversationState');
const { releaseTablesForToken } = require('../helpers/tableRelease');
const { writeAuditLog } = require('../helpers/auditLog');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');
const { requireKdsSecretOrJwt, requireKdsSecret } = require('../middleware/internalAuth');

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
  const { data: allTokens } = await supabaseAdmin
    .from('walk_in_tokens').select('id').eq('restaurant_id', restaurantId);

  let maxSeq = 0;
  for (const row of allTokens ?? []) {
    const match = String(row.id).match(/^T-(\d+)$/);
    if (match) { const n = parseInt(match[1], 10); if (n > maxSeq) maxSeq = n; }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `T-${String(maxSeq + 1 + attempt).padStart(3, '0')}`;
    const { data: existing } = await supabaseAdmin
      .from('walk_in_tokens').select('id').eq('id', candidate).maybeSingle();
    if (!existing) return candidate;
  }
  return `T-${Date.now().toString().slice(-6)}`;
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
    return { ok: false, statusCode: 409, error: 'Token already approved or rejected' };
  }

  if (meta.booking_id) {
    await supabaseAdmin.from('bookings')
      .update({ status: 'confirmed' })
      .eq('id', meta.booking_id);
  }

  if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
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
    return { ok: false, statusCode: 409, error: 'Token already approved or rejected' };
  }

  if (meta.booking_id) {
    await supabaseAdmin.from('bookings')
      .update({ status: 'rejected' })
      .eq('id', meta.booking_id);
  }

  if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
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
    if (!['dinein', 'takeaway', 'large_party', 'scheduled_delivery'].includes(type))
      return res.status(400).json({ error: 'type must be dinein, takeaway, large_party, or scheduled_delivery' });

    if (type === 'scheduled_delivery' && meta?.scheduled_at) {
      const slotCheck = validateScheduledDeliverySlot(meta.scheduled_at);
      if (!slotCheck.valid) {
        return res.status(400).json({ error: slotCheck.message, reason: slotCheck.reason });
      }
    }

    const tokenId = await generateTokenId(restaurant_id);
    const status  = (type === 'large_party' || type === 'scheduled_delivery') ? 'pending_approval'
                  : type === 'takeaway'    ? 'takeaway'
                  : 'waiting';

    const tokenRecord = {
      id:          tokenId,
      restaurant_id,
      name:        name.trim(),
      phone:       phone ? String(phone).replace(/\D/g, '') : null,
      type,
      pax:         (type === 'takeaway' || type === 'scheduled_delivery') ? 1 : (parseInt(pax) || 1),
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

    const arrivalTime = new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', year: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).replace(',', ', ');
    const portalUrl = `${process.env.FRONTEND_URL || 'https://app.autom8.works'}/dashboard/manager`;

    // Resolve manager phone (outlet row first, then global env)
    let managerPhone = await getManagerPhone(restaurant_id);

    // notify=false skips the manager alert (e.g. duplicate guard). Default: send from API.
    const shouldNotify = req.query.notify !== 'false';
    if (shouldNotify && managerPhone && process.env.WHATSAPP_ACCESS_TOKEN) {
      if (type === 'large_party') {
        const combo      = meta?.combo ?? [];
        const tableLines = combo.length > 0
          ? combo.map(t => `Table ${t[0]} (${t[2]}/${t[1]} seats)`).join(' + ')
          : `${token.pax} seats`;
        sendWhatsAppMessage(
          managerPhone,
          `🟣 *Large Party Request* — Token *${token.id}*\n👥 ${token.name} · *${token.pax} people*\n🕐 ${arrivalTime} IST\n\nProposed: ${tableLines}\n\n⚠️ *Action required:*\n${portalUrl}`,
          restaurant_id
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
        const sent = await sendWhatsAppInteractive(
          managerPhone,
          {
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
          restaurant_id,
        );
        if (!sent) {
          sendWhatsAppMessage(
            managerPhone,
            `${body}\n\n⚠️ *Approve in portal before customer pays:*\n${portalUrl}`,
            restaurant_id
          );
        }
      } else if (type === 'dinein') {
        sendWhatsAppMessage(
          managerPhone,
          `🪑 *New Walk-in* — Token *${token.id}*\n` +
          `👤 ${token.name}, ${token.pax} ${token.pax === 1 ? 'person' : 'people'}\n` +
          `🍽️ Dine-in\n🕐 ${arrivalTime} IST\n\n` +
          `Open portal to assign table:\n${portalUrl}`,
          restaurant_id
        );
      } else {
        sendWhatsAppMessage(
          managerPhone,
          `🪑 *New Walk-in* — Token *${token.id}*\n👤 ${token.name}\n📦 Takeaway\n🕐 ${arrivalTime} IST\n\n${portalUrl}`,
          restaurant_id
        );
      }
    }

    broadcastToRestaurant(restaurant_id, {
      type:        'TOKEN_NEW',
      token_id:    token.id,
      token,
      timestamp:   new Date().toISOString(),
    });
    res.status(201).json({ success: true, token });
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

    const managerPhone = await getManagerPhone(restaurant_id);
    if (!managerPhone) {
      console.warn(`[manager-order-alert] No manager phone for restaurant ${restaurant_id}`);
      return res.status(400).json({ error: 'manager_phone not configured' });
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

    await sendWhatsAppMessage(managerPhone, body, restaurant_id);
    console.log(`[manager-order-alert] ✅ ${token_number} → ${managerPhone}`);
    return res.json({ success: true, manager_phone: managerPhone });
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

    await supabaseAdmin.from('tables').update({ status: 'occupied' }).eq('id', table_id).eq('restaurant_id', restaurantId);

    let menuSendResult = {};
    if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
      await sendWhatsAppMessage(
        token.phone,
        `✅ *Your table is ready!*\n\nToken: *${token.id}*\nTable: *Table ${table_number}*\n\nPlease proceed to your table. Enjoy! 🍽️`,
        restaurantId
      );
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
          table_ids: tableIds,
          table_numbers: tableNumbers,
        },
      })
      .eq('id', req.params.id).select().single();

    if (tableIds.length > 0)
      await supabaseAdmin.from('tables').update({ status: 'occupied' }).in('id', tableIds).eq('restaurant_id', restaurantId);

    let menuSendResult = {};
    if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
      await sendWhatsAppMessage(
        token.phone,
        `✅ *Your table arrangement has been confirmed.*\n\nToken: *${token.id}*\nParty of: *${token.pax} people*\nTables: *${tableNumbers.join(', ')}*\n\nPlease head to the restaurant! 🍽️`,
        restaurantId
      );
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
      return res.json({ success: true, token: result.token });
    }

    if (token.status !== 'pending_approval') {
      return res.status(409).json({ error: `Token is ${token.status}` });
    }

    const { data: updatedToken } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('status', 'pending_approval')
      .select()
      .maybeSingle();

    if (!updatedToken) {
      return res.status(409).json({ error: 'Token already approved or rejected' });
    }

    if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
      const reasonLine = req.body.reason ? `\n\nReason: ${req.body.reason}` : '';
      await sendWhatsAppMessage(
        token.phone,
        `😔 *We're unable to accommodate your party of ${token.pax} right now.*${reasonLine}\n\nReply *RESERVE* to book for a future date. 🙏`,
        restaurantId
      );
    }

    broadcastToRestaurant(restaurantId, { type: 'TOKEN_REJECTED', token: updatedToken, timestamp: new Date().toISOString() });
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
    if (token.type !== 'scheduled_delivery') {
      return res.status(400).json({ error: 'Internal approve supports scheduled_delivery only' });
    }

    const result = await approveScheduledDeliveryToken(req.params.id, restaurantId, token);
    if (!result.ok) {
      return res.status(result.statusCode || 400).json({ error: result.error });
    }
    res.json({ success: true, token: result.token });
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
    if (token.type !== 'scheduled_delivery') {
      return res.status(400).json({ error: 'Internal reject supports scheduled_delivery only' });
    }

    const result = await rejectScheduledDeliveryToken(
      req.params.id, restaurantId, token, req.body.reason,
    );
    if (!result.ok) {
      return res.status(result.statusCode || 400).json({ error: result.error });
    }
    res.json({ success: true, token: result.token });
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
