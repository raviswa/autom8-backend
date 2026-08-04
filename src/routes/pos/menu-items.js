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

// ── Menu items ───────────────────────────────────────────────────────────────

router.get('/menu-items', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { category, ignore_slot } = req.query;
    const isManagerView = ignore_slot === 'true';

    const now        = new Date();
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const istMinutes = (utcMinutes + 330) % (24 * 60);
    const istHour    = Math.floor(istMinutes / 60);
    let currentSlot;
    if      (istHour >= 6  && istHour < 11) currentSlot = 'morning_tiffin';
    else if (istHour >= 11 && istHour < 15) currentSlot = 'lunch';
    else if (istHour >= 15 && istHour < 19) currentSlot = 'evening_snacks';
    else if (istHour >= 19 && istHour < 23) currentSlot = 'dinner_tiffin';
    else                                    currentSlot = null;

    let query = supabaseAdmin.from('menu_items').select('*')
      .eq('restaurant_id', req.restaurant_id)
      .is('archived_at', null)          // ← add this line
      .order('time_slot', { ascending: true })
      .order('name',      { ascending: true });

    if (category) query = query.eq('category', category);

    if (isManagerView) {
      query = query.order('is_stocked', { ascending: false });
    } else {
      query = query.eq('is_available', true);
      if (currentSlot) query = query.or(`time_slot.eq.${currentSlot},time_slot.eq.all`);
    }

    const { data, error } = await query;
    if (error) throw error;
    const { resolveMenuItemImageFields } = require('../../helpers/publicImageUrl');
    const items = await Promise.all((data || []).map((row) => resolveMenuItemImageFields(row)));
    res.json({ success: true, count: items.length, items, current_slot: currentSlot, ist_hour: istHour });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST/PUT/DELETE /api/menu-items are mounted from catalog (server.js) before this router.


// ── Orders ───────────────────────────────────────────────────────────────────

module.exports = router;
