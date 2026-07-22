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

module.exports = router;
