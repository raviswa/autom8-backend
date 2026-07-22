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
      menuSendResult = await sendWhatsAppCatalogWithSpecials(token.phone, restaurantId, token.id);
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

// ── PUT /api/tokens/:id/promote-large-party — waiting dine-in → large party approval ─

router.put('/:id/promote-large-party', outletAuth, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner', 'brand_manager'].includes(req.user_role)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const restaurantId = req.restaurant_id;

    const { data: token } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('*')
      .eq('id', req.params.id)
      .eq('restaurant_id', restaurantId)
      .single();
    if (!token) return res.status(404).json({ error: 'Token not found' });
    if (token.status !== 'waiting' || token.type !== 'dinein') {
      return res.status(400).json({ error: 'Only waiting dine-in tokens can be promoted' });
    }
    const partySize = parseInt(token.pax, 10) || 1;
    if (partySize <= LARGE_PARTY_THRESHOLD) {
      return res.status(400).json({ error: `Party size must be over ${LARGE_PARTY_THRESHOLD}` });
    }

    const availTables = await fetchAvailableTables(restaurantId);
    const combo = pickTableCombo(availTables, partySize);
    const nextMeta = { ...(token.meta || {}) };
    if (combo) nextMeta.combo = combo;

    const { data: updated, error } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({
        type: 'large_party',
        status: 'pending_approval',
        meta: nextMeta,
      })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;

    broadcastToRestaurant(restaurantId, {
      type: 'TOKEN_UPDATED',
      token: updated,
      timestamp: new Date().toISOString(),
    });
    res.json({ success: true, token: updated });
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
    let tableNumbers = combo.map(t => String(t[0]));
    if (tableNumbers.length === 0 && (parseInt(token.pax, 10) || 1) > LARGE_PARTY_THRESHOLD) {
      try {
        const availTables = await fetchAvailableTables(restaurantId);
        const computed = pickTableCombo(availTables, token.pax);
        if (computed) tableNumbers = computed.map(t => String(t[0]));
      } catch (comboErr) {
        console.warn('[tokens] approve combo recompute failed:', comboErr.message);
      }
    }
    if (tableNumbers.length === 0) {
      return res.status(409).json({ error: 'No suitable table combination available for this party size' });
    }
    let tableIds       = [];
    if (tableNumbers.length > 0) {
      const { data: tableRows } = await supabaseAdmin
        .from('tables').select('id, table_number').eq('restaurant_id', restaurantId).in('table_number', tableNumbers);
      tableIds = (tableRows ?? []).map(t => t.id);
    }

    const { data: updatedToken, error: approveErr } = await supabaseAdmin
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

    if (approveErr) throw approveErr;
    if (!updatedToken) {
      return res.status(500).json({
        error: 'Approval update did not persist. If RLS was recently enabled, verify SUPABASE_SERVICE_ROLE_KEY (not anon key) is set on the API service.',
      });
    }

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
      menuSendResult = await sendWhatsAppCatalogWithSpecials(token.phone, restaurantId, token.id);
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
