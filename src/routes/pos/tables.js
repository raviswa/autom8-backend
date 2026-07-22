'use strict';

const express = require('express');
const router  = express.Router();
const {
  supabaseAdmin,
  invalidateRestaurantConfigCache,
  writeAuditLog,
  authenticateToken,
  getRestaurantId,
  withAudit,
  auditOwnerDashboardContext,
  normalizeShippingProvider,
  normalizeRateCard,
  normalizePincode,
  resolveCourierZone,
  chargeFromRateCard,
  fetchShiprocketCourierOptions,
  broadcastToRestaurant,
  sendWhatsAppMessage,
  sendWhatsAppCatalogMessage,
  notifyOrderReady,
  notifyPackingTicketAlert,
  queueForStation,
  queueFeedbackForTable,
  resolvePickupLocation,
  parseGoogleMapsCoords,
  resolveFailureMessage,
  ORDER_SERVICES,
  resolvePaidFeatures,
  mergeEnabledFeatures,
  validateEnabledFeatures,
  enabledOrderServices,
  dispatchBookingToKds,
  runDueScheduledJobsForRestaurant,
  reconcileMissedKdsDispatches,
  explainKdsVisibility,
  formatTokenDisplay,
  looksLikeShiprocketJwt,
  sanitizeRestaurantForClient,
  requireSettingsAccess,
  enrichScheduledOrdersFromPortal,
} = require('./shared');

router.get('/tables', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('tables').select('*')
      .eq('restaurant_id', req.restaurant_id).order('table_number', { ascending: true });
    if (error) throw error;
    res.json({ success: true, tables: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/tables/:id/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabaseAdmin.from('tables')
      .update({ status }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;

    if (status === 'available') {
      try {
        const { data: recentToken } = await supabaseAdmin.from('walk_in_tokens')
          .select('phone, name, id as token_number, restaurant_id')
          .eq('table_id', req.params.id).eq('status', 'seated')
          .order('seated_at', { ascending: false }).limit(1).maybeSingle();
        if (recentToken?.phone) {
          await queueFeedbackForTable({
            tableId:       req.params.id,
            customerPhone: recentToken.phone,
            customerName:  recentToken.name,
            tokenId:       recentToken.token_number,
            restaurantId:  recentToken.restaurant_id,
            source:        'table-status-available',
          });
        }
      } catch (feedbackQueueErr) {
        console.error('[table-freed] Failed to queue feedback:', feedbackQueueErr.message);
      }
    }

    res.json({ success: true, table: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/tables', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    const { table_number, capacity = 4, section = null } = req.body;
    if (!table_number) return res.status(400).json({ error: 'table_number is required' });
    const { data, error } = await supabaseAdmin
      .from('tables')
      .insert({ restaurant_id: req.restaurant_id, table_number: parseInt(table_number), capacity: parseInt(capacity), section, status: 'available', is_active: true })
      .select().single();
    if (error) throw error;
    res.status(201).json({ success: true, table: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/tables/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    const { table_number, capacity, section, is_active } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (table_number !== undefined) updates.table_number = parseInt(table_number);
    if (capacity     !== undefined) updates.capacity     = parseInt(capacity);
    if (section      !== undefined) updates.section      = section;
    if (is_active    !== undefined) updates.is_active    = Boolean(is_active);
    const { data, error } = await supabaseAdmin
      .from('tables')
      .update(updates)
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;
    res.json({ success: true, table: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/tables/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    // Block delete if table is currently occupied
    const { data: table } = await supabaseAdmin
      .from('tables').select('status, table_number').eq('id', req.params.id).single();
    if (table?.status === 'occupied')
      return res.status(409).json({ error: `Table ${table.table_number} is currently occupied — free it before deleting` });
    const { error } = await supabaseAdmin
      .from('tables')
      .delete()
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Resolve cloud-kitchen pickup coordinates from Maps link or address ─────────

module.exports = router;
