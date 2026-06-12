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
const { sendWhatsAppMessage, sendWhatsAppCatalogMessage } = require('../helpers/whatsapp');
const { queueFeedbackForTable }   = require('../helpers/feedback');
const { syncConversationForTokenApproval } = require('../helpers/conversationState');
const { authenticateToken }       = require('../middleware/auth');
const { requireKdsSecretOrJwt, requireKdsSecret } = require('../middleware/internalAuth');

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

// ── POST /api/tokens ──────────────────────────────────────────────────────────

router.post('/', requireKdsSecretOrJwt, async (req, res) => {
  try {
    const { name, phone, type, pax, restaurant_id, meta } = req.body;

    if (!name?.trim())    return res.status(400).json({ error: 'name is required' });
    if (!type)            return res.status(400).json({ error: 'type is required' });
    if (!restaurant_id)   return res.status(400).json({ error: 'restaurant_id is required' });
    if (!['dinein', 'takeaway', 'large_party'].includes(type))
      return res.status(400).json({ error: 'type must be dinein, takeaway, or large_party' });

    const tokenId = await generateTokenId(restaurant_id);
    const status  = type === 'large_party' ? 'pending_approval'
                  : type === 'takeaway'    ? 'takeaway'
                  : 'waiting';

    const tokenRecord = {
      id:          tokenId,
      restaurant_id,
      name:        name.trim(),
      phone:       phone ? String(phone).replace(/\D/g, '') : null,
      type,
      pax:         type === 'takeaway' ? 1 : (parseInt(pax) || 1),
      status,
      arrived_at:  new Date().toISOString(),
      meta:        meta || {},
    };

    const { data: token, error: insertError } = await supabaseAdmin
      .from('walk_in_tokens').insert(tokenRecord).select().single();
    if (insertError) throw insertError;

    const arrivalTime = new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
    });

    // Resolve manager phone (outlet row first, then global env)
    let managerPhone = process.env.MANAGER_WHATSAPP_NUMBER || null;
    try {
      const { data: rest } = await supabaseAdmin
        .from('restaurants').select('manager_phone').eq('id', restaurant_id).single();
      if (rest?.manager_phone) managerPhone = rest.manager_phone;
    } catch (_) {}

    if (managerPhone && process.env.WHATSAPP_ACCESS_TOKEN) {
      if (type === 'large_party') {
        const combo      = meta?.combo ?? [];
        const tableLines = combo.length > 0
          ? combo.map(t => `Table ${t[0]} (${t[2]}/${t[1]} seats)`).join(' + ')
          : `${token.pax} seats`;
        sendWhatsAppMessage(
          managerPhone,
          `🟣 *Large Party Request* — Token *${token.id}*\n👥 ${token.name} · *${token.pax} people*\n🕐 ${arrivalTime}\n\nProposed: ${tableLines}\n\n⚠️ *Action required:*\n${process.env.FRONTEND_URL || ''}/dashboard/manager`,
          restaurant_id
        );
      } else if (req.query.notify !== 'false') {
        const typeLabel = type === 'dinein' ? 'Dine-in' : 'Takeaway';
        const paxLine   = type === 'dinein' ? `, ${token.pax} ${token.pax === 1 ? 'person' : 'people'}` : '';
        sendWhatsAppMessage(
          managerPhone,
          `🪑 *New Walk-in* — Token *${token.id}*\n👤 ${token.name}${paxLine}\n📋 ${typeLabel}\n🕐 ${arrivalTime}\n\n${process.env.FRONTEND_URL || ''}/dashboard/manager`,
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

// ── GET /api/tokens ───────────────────────────────────────────────────────────

router.get('/', authenticateToken, async (req, res) => {
  try {
    const { data: userData } = await supabaseAdmin
      .from('employees').select('restaurant_id').eq('id', req.user.sub).single();
    const restaurantId = userData?.restaurant_id;
    if (!restaurantId) return res.status(401).json({ error: 'No restaurant assigned' });

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const { status } = req.query;

    let query = supabaseAdmin
      .from('walk_in_tokens').select('*')
      .eq('restaurant_id', restaurantId)
      .order('arrived_at', { ascending: true });

    if (status) {
      query = query.eq('status', status).gte('arrived_at', todayStart.toISOString());
    } else {
      query = query.or(
        `status.in.(waiting,seated,takeaway,pending_approval),` +
        `and(status.eq.completed,arrived_at.gte.${todayStart.toISOString()})`
      );
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

router.put('/:id/assign', authenticateToken, async (req, res) => {
  try {
    const { data: userData } = await supabaseAdmin
      .from('employees').select('restaurant_id').eq('id', req.user.sub).single();
    const restaurantId = userData?.restaurant_id;

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

    if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
      await sendWhatsAppMessage(
        token.phone,
        `✅ *Your table is ready!*\n\nToken: *${token.id}*\nTable: *Table ${table_number}*\n\nPlease proceed to your table. Enjoy! 🍽️`,
        restaurantId
      );
      await sendWhatsAppCatalogMessage(token.phone, restaurantId);
    }

    await syncConversationForTokenApproval({
      restaurantId,
      customerPhone: token.phone,
      tokenId:       token.id,
      tableNumbers:  [String(table_number)],
      partySize:     token.pax,
    });

    broadcastToRestaurant(restaurantId, { type: 'TOKEN_ASSIGNED', token: updatedToken, timestamp: new Date().toISOString() });

    await supabaseAdmin.from('audit_logs').insert({
      user_id: req.user.sub, restaurant_id: restaurantId,
      action: 'Token assigned to table', details: { token_id: req.params.id, table_id, table_number },
    }).catch(() => {});

    res.json({ success: true, token: updatedToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/tokens/:id/approve ───────────────────────────────────────────────

router.put('/:id/approve', authenticateToken, async (req, res) => {
  try {
    const { data: userData } = await supabaseAdmin
      .from('employees').select('role, restaurant_id').eq('id', req.user.sub).single();
    if (!['owner', 'manager', 'brand_owner', 'brand_manager'].includes(userData?.role))
      return res.status(403).json({ error: 'Unauthorized' });
    const restaurantId = userData.restaurant_id;

    const { data: token } = await supabaseAdmin
      .from('walk_in_tokens').select('*').eq('id', req.params.id).eq('restaurant_id', restaurantId).single();
    if (!token) return res.status(404).json({ error: 'Token not found' });
    if (token.status !== 'pending_approval') return res.status(400).json({ error: `Token is ${token.status}` });

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
      .update({ status: 'seated', table_id: tableIds[0] ?? null, table_number: tableNumbers[0] ?? null, seated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();

    if (tableIds.length > 0)
      await supabaseAdmin.from('tables').update({ status: 'occupied' }).in('id', tableIds).eq('restaurant_id', restaurantId);

    if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
      await sendWhatsAppMessage(
        token.phone,
        `✅ *Your table arrangement has been confirmed.*\n\nToken: *${token.id}*\nParty of: *${token.pax} people*\nTables: *${tableNumbers.join(', ')}*\n\nPlease head to the restaurant! 🍽️`,
        restaurantId
      );
      await sendWhatsAppCatalogMessage(token.phone, restaurantId);
    }

    await syncConversationForTokenApproval({
      restaurantId,
      customerPhone: token.phone,
      tokenId:       token.id,
      tableNumbers,
      partySize:     token.pax,
    });

    broadcastToRestaurant(restaurantId, { type: 'TOKEN_APPROVED', token: updatedToken, timestamp: new Date().toISOString() });
    res.json({ success: true, token: updatedToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/tokens/:id/reject ────────────────────────────────────────────────

router.put('/:id/reject', authenticateToken, async (req, res) => {
  try {
    const { data: userData } = await supabaseAdmin
      .from('employees').select('role, restaurant_id').eq('id', req.user.sub).single();
    if (!['owner', 'manager', 'brand_owner', 'brand_manager'].includes(userData?.role))
      return res.status(403).json({ error: 'Unauthorized' });

    const { data: token } = await supabaseAdmin
      .from('walk_in_tokens').select('*').eq('id', req.params.id).eq('restaurant_id', userData.restaurant_id).single();
    if (!token) return res.status(404).json({ error: 'Token not found' });

    const { data: updatedToken } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();

    if (token.phone && process.env.WHATSAPP_ACCESS_TOKEN) {
      const reasonLine = req.body.reason ? `\n\nReason: ${req.body.reason}` : '';
      await sendWhatsAppMessage(
        token.phone,
        `😔 *We're unable to accommodate your party of ${token.pax} right now.*${reasonLine}\n\nReply *RESERVE* to book for a future date. 🙏`,
        userData.restaurant_id
      );
    }

    broadcastToRestaurant(userData.restaurant_id, { type: 'TOKEN_REJECTED', token: updatedToken, timestamp: new Date().toISOString() });
    res.json({ success: true, token: updatedToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/tokens/:id/complete ──────────────────────────────────────────────

router.put('/:id/complete', authenticateToken, async (req, res) => {
  try {
    const { data: userData } = await supabaseAdmin
      .from('employees').select('restaurant_id').eq('id', req.user.sub).single();
    const restaurantId = userData.restaurant_id;

    const { data: token } = await supabaseAdmin
      .from('walk_in_tokens').select('*').eq('id', req.params.id).eq('restaurant_id', restaurantId).single();
    if (!token) return res.status(404).json({ error: 'Token not found' });

    const { data: updatedToken } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();

    if (token.table_id) {
      const { data: activeOrders } = await supabaseAdmin
        .from('orders').select('id').eq('table_id', token.table_id)
        .in('status', ['pending', 'confirmed', 'in_progress']);

      if (!activeOrders || activeOrders.length === 0) {
        await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', token.table_id).eq('restaurant_id', restaurantId);

        // Feedback queue — 2-hour delayed WhatsApp star rating
        await queueFeedbackForTable({
          tableId:       token.table_id,
          customerPhone: token.phone,
          customerName:  token.name,
          tokenId:       token.id,
          restaurantId,
          source:        'token-complete',
        }).catch(e => console.error('[token-complete] feedback queue failed:', e.message));
      }
    }

    broadcastToRestaurant(restaurantId, { type: 'TOKEN_COMPLETED', token: updatedToken, timestamp: new Date().toISOString() });
    res.json({ success: true, token: updatedToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/tokens/:id ────────────────────────────────────────────────────

router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { data: userData } = await supabaseAdmin
      .from('employees').select('restaurant_id').eq('id', req.user.sub).single();
    const { error } = await supabaseAdmin
      .from('walk_in_tokens').delete().eq('id', req.params.id).eq('restaurant_id', userData.restaurant_id);
    if (error) throw error;
    res.json({ success: true, message: 'Token dismissed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
