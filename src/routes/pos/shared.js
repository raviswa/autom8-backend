'use strict';

const { supabaseAdmin }           = require('../../config/supabase');
const { invalidateRestaurantConfigCache } = require('../../helpers/restaurantConfig');
const { writeAuditLog } = require('../../helpers/auditLog');
const {
  authenticateToken,
  getRestaurantId,
  canManageRestaurantSettings,
} = require('../../middleware/auth');
const { withAudit, auditOwnerDashboardContext } = require('../../middleware/audit');
const { estimateKitchenStartFromTotals, assignScheduledBucket } = require('../../helpers/kitchenScheduler');
const {
  normalizeShippingProvider,
  normalizeRateCard,
  normalizePincode,
  resolveCourierZone,
  chargeFromRateCard,
} = require('../../helpers/courierRates');
const { fetchShiprocketCourierOptions } = require('../../helpers/shiprocket');
const { broadcastToRestaurant }   = require('../../websocket');
const { sendWhatsAppMessage, sendWhatsAppCatalogMessage } = require('../../helpers/whatsapp');
const { applySlotAvailability, getCurrentSlotIST } = require('../catalog');
const { notifyOrderReady }        = require('../../helpers/whatsapp');
const { notifyPackingTicketAlert } = require('../../helpers/packingAlerts');
const { queueForStation } = require('../../helpers/kdsQueue');
const { queueFeedbackForTable }   = require('../../helpers/feedback');
const {
  resolvePickupLocation,
  parseGoogleMapsCoords,
  resolveFailureMessage,
} = require('../../helpers/googleMaps');
const {
  ORDER_SERVICES,
  resolvePaidFeatures,
  mergeEnabledFeatures,
  validateEnabledFeatures,
  enabledOrderServices,
} = require('../../helpers/subscriptionFeatures');
const {
  dispatchBookingToKds,
  runDueScheduledJobsForRestaurant,
  reconcileMissedKdsDispatches,
  explainKdsVisibility,
} = require('../../helpers/scheduledJobs');
const { formatTokenDisplay } = require('../../helpers/portalTokens');

function looksLikeShiprocketJwt(value) {
  const s = String(value || '').trim();
  return s.startsWith('eyJ') && s.split('.').length >= 3;
}

/** Never send Shiprocket API User password (shiprocket_api_key) to the browser. */
function sanitizeRestaurantForClient(row) {
  if (!row) return row;
  const { shiprocket_api_key, ...rest } = row;
  return {
    ...rest,
    shiprocket_has_password: !!String(shiprocket_api_key || '').trim(),
  };
}

function requireSettingsAccess(req, res, next) {
  if (!canManageRestaurantSettings(req.user_role))
    return res.status(403).json({ error: 'Unauthorized' });
  if (!req.restaurant_id)
    return res.status(403).json({ error: 'No restaurant outlet linked to this account' });
  next();
}

function cartSnapshotToOrderText(cart) {
  if (!cart || typeof cart !== 'object') return '';
  return Object.values(cart)
    .filter((line) => line && typeof line === 'object')
    .map((line) => {
      const qty = line.qty ?? line.quantity ?? 1;
      const name = line.title || line.name || 'Item';
      return `${qty}x ${name}`;
    })
    .filter(Boolean)
    .join(', ');
}

function resolveScheduledOrderText(scheduleMeta, portalMeta) {
  const meta = scheduleMeta && typeof scheduleMeta === 'object' ? scheduleMeta : {};
  const portal = portalMeta && typeof portalMeta === 'object' ? portalMeta : {};
  if (meta.order_text) return meta.order_text;
  if (portal.order_text) return portal.order_text;
  const cart = (meta.cart && Object.keys(meta.cart).length ? meta.cart : portal.cart) || {};
  return cartSnapshotToOrderText(cart);
}

function estimateKitchenStart(slotAt, serviceType, totalCookMinutes, scheduleMeta, totalPackingMinutes) {
  return estimateKitchenStartFromTotals(slotAt, {
    serviceType,
    totalCookMinutes,
    totalPackingMinutes,
    scheduleMeta,
  });
}

function resolveScheduledKitchenStart(order) {
  const stored = order.kitchen_start_at || order.schedule_meta?.kitchen_start_at;
  if (stored) return new Date(stored);
  const meta = {
    ...(order.schedule_meta || {}),
    cart: order.cart,
    service_type: order.service_type,
    transit_minutes: order.transit_minutes ?? order.schedule_meta?.transit_minutes,
    delivery_travel_minutes: order.schedule_meta?.delivery_travel_minutes,
  };
  return estimateKitchenStart(
    order.scheduled_slot_at,
    order.service_type,
    order.total_cook_minutes,
    meta,
    order.total_packing_minutes,
  );
}

function finalizeScheduledOrder(order, kitchenStart, now = new Date()) {
  const withKitchen = {
    ...order,
    kitchen_start_at: kitchenStart ? kitchenStart.toISOString() : order.kitchen_start_at,
  };
  return {
    ...withKitchen,
    bucket: assignScheduledBucket(withKitchen, now),
  };
}

/** Merge portal token meta + recompute kitchen start for every scheduled order. */
async function enrichScheduledOrdersFromPortal(restaurantId, orders) {
  if (!orders?.length) return orders;

  const bookingIds = new Set(orders.map((o) => o.booking_id));
  const { data: tokens, error } = await supabaseAdmin
    .from('walk_in_tokens')
    .select('id, meta, type')
    .eq('restaurant_id', restaurantId)
    .in('type', ['scheduled_takeaway', 'scheduled_delivery']);

  if (error) {
    console.warn('[kds/scheduled] portal token enrich failed:', error.message);
    return orders.map((order) => finalizeScheduledOrder(
      order,
      resolveScheduledKitchenStart(order),
    ));
  }

  const portalByBooking = new Map();
  const portalByTokenId = new Map();
  for (const token of tokens ?? []) {
    const bid = token.meta?.booking_id;
    if (bid && bookingIds.has(bid)) {
      const prev = portalByBooking.get(bid);
      if (!prev || String(token.id).localeCompare(String(prev.id)) > 0) {
        portalByBooking.set(bid, token);
      }
    }
    if (token.id) {
      portalByTokenId.set(String(token.id).toUpperCase(), token);
    }
  }

  const resolvePortalToken = (order) => {
    const byBooking = portalByBooking.get(order.booking_id);
    if (byBooking) return byBooking;
    const raw = String(order.token_number || '').trim().toUpperCase();
    if (!raw) return null;
    return portalByTokenId.get(raw)
      || portalByTokenId.get(raw.startsWith('T-') ? raw : `T-${raw}`)
      || null;
  };

  return orders.map((order) => {
    const portal = resolvePortalToken(order);
    if (!portal) {
      return finalizeScheduledOrder(order, resolveScheduledKitchenStart(order));
    }
    const portalMeta = portal.meta || {};
    const cart = (order.cart && Object.keys(order.cart).length)
      ? order.cart
      : (portalMeta.cart || {});
    const orderText = resolveScheduledOrderText(
      { order_text: order.order_text, cart },
      portalMeta,
    );
    const tokenNumber = String(order.token_number || '').startsWith('T-')
      ? order.token_number
      : (portal.id || order.token_number);
    const portalType = String(portal.type || '').toLowerCase();
    const serviceType = portalType === 'scheduled_delivery'
      ? 'delivery'
      : portalType === 'scheduled_takeaway'
        ? 'takeaway'
        : order.service_type;
    const scheduleMeta = {
      ...(order.schedule_meta || {}),
      ...portalMeta,
      cart,
      service_type: serviceType,
    };
    const cookMinutes = portalMeta.total_cook_minutes
      ?? scheduleMeta.total_cook_minutes
      ?? order.total_cook_minutes;
    const packingMinutes = portalMeta.total_packing_minutes
      ?? scheduleMeta.total_packing_minutes
      ?? order.total_packing_minutes;
    return {
      ...order,
      token_number: tokenNumber,
      order_text: orderText || order.order_text,
      cart,
      service_type: serviceType,
      schedule_meta: scheduleMeta,
      total_cook_minutes: cookMinutes,
      total_packing_minutes: packingMinutes,
      transit_minutes: scheduleMeta.transit_minutes ?? scheduleMeta.delivery_travel_minutes ?? null,
    };
  }).map((order, _idx, list) => {
    const cartKey = (cart) => {
      if (!cart || !Object.keys(cart).length) return '';
      return Object.keys(cart).sort().map((k) => `${k}:${cart[k]?.qty || 1}`).join('|');
    };
    const maxCookByCart = new Map();
    for (const o of list) {
      const key = cartKey(o.cart);
      if (!key) continue;
      const cook = Number(o.total_cook_minutes) || 0;
      maxCookByCart.set(key, Math.max(maxCookByCart.get(key) || 0, cook));
    }
    const key = cartKey(order.cart);
    const alignedCook = key ? (maxCookByCart.get(key) || order.total_cook_minutes) : order.total_cook_minutes;
    const aligned = {
      ...order,
      total_cook_minutes: alignedCook,
    };
    const kitchenStart = resolveScheduledKitchenStart(aligned);
    return finalizeScheduledOrder(aligned, kitchenStart);
  });
}

module.exports = {
  supabaseAdmin,
  invalidateRestaurantConfigCache,
  writeAuditLog,
  authenticateToken,
  getRestaurantId,
  canManageRestaurantSettings,
  withAudit,
  auditOwnerDashboardContext,
  estimateKitchenStartFromTotals,
  assignScheduledBucket,
  normalizeShippingProvider,
  normalizeRateCard,
  normalizePincode,
  resolveCourierZone,
  chargeFromRateCard,
  fetchShiprocketCourierOptions,
  broadcastToRestaurant,
  sendWhatsAppMessage,
  sendWhatsAppCatalogMessage,
  applySlotAvailability,
  getCurrentSlotIST,
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
  cartSnapshotToOrderText,
  resolveScheduledOrderText,
  estimateKitchenStart,
  resolveScheduledKitchenStart,
  finalizeScheduledOrder,
  enrichScheduledOrdersFromPortal,
};
