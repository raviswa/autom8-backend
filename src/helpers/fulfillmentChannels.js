'use strict';

/**
 * Packed-food fulfillment channels: pickup vs delivery, same-city
 * own_team vs shiprocket (manager gate), outstation shiprocket-only.
 *
 * own_team sub-modes (own_team_mode):
 *   own_driver       — merchant staff; notify on pack (default)
 *   local_rider_app  — Dunzo/Rapido/Porter; notify after rider details
 *   parcel_courier   — India Post/DTDC/etc; notify after courier + AWB
 */

const { resolveCourierZone, normalizePincode, normalizeShippingProvider } = require('./courierRates');
const { resolveEnabledFeatures, enabledOrderServices, ALL_FEATURES } = require('./subscriptionFeatures');

const LOCAL_CHANNEL_PENDING_HOURS = 4;
const SHIPPED_LOBS = new Set(['food_products', 'retail', 'psl', 'b2b']);
const OWN_TEAM_MODES = new Set(['own_driver', 'local_rider_app', 'parcel_courier']);

function hasShiprocketCreds(restaurant) {
  return !!(
    String(restaurant?.shiprocket_email || '').trim()
    && String(restaurant?.shiprocket_api_key || '').trim()
  ) || !!restaurant?.shiprocket_connected;
}

function packagedServicesEnabled(restaurant) {
  const enabled = enabledOrderServices(
    resolveEnabledFeatures(restaurant, ALL_FEATURES),
  );
  const hasTakeaway = enabled.includes('takeaway');
  const hasDelivery = enabled.includes('delivery');
  // If tenant never configured services, default both on for packaged LOBs.
  if (!hasTakeaway && !hasDelivery) {
    return { takeaway: true, delivery: true, enabled };
  }
  return { takeaway: hasTakeaway, delivery: hasDelivery, enabled };
}

function isShippedLob(lobType) {
  return SHIPPED_LOBS.has(String(lobType || '').toLowerCase());
}

/**
 * Normalize own_team delivery sub-mode. Unset → own_driver (legacy default).
 */
function normalizeOwnTeamMode(raw) {
  const mode = String(raw || '').trim().toLowerCase();
  if (OWN_TEAM_MODES.has(mode)) return mode;
  return 'own_driver';
}

function needsShipmentDetailsBeforeNotify(meta = {}) {
  const channel = String(meta.delivery_channel || '').toLowerCase();
  if (channel === 'shiprocket') return false;
  if (channel !== 'own_team' && channel !== 'custom') return false;
  const mode = normalizeOwnTeamMode(meta.own_team_mode);
  return mode === 'local_rider_app' || mode === 'parcel_courier';
}

/**
 * Resolve shopper choice into booking/walk-in meta fields.
 */
function buildFulfillmentMeta({
  fulfillmentType,
  deliveryChannel,
  ownTeamMode,
  quote,
  restaurant,
}) {
  const type = String(fulfillmentType || '').toLowerCase() === 'pickup'
    ? 'pickup'
    : 'delivery';

  if (type === 'pickup') {
    return {
      fulfillment_type: 'pickup',
      service_type: 'takeaway',
      delivery_channel: null,
      delivery_channel_requested: null,
      delivery_channel_status: 'confirmed',
      own_team_mode: null,
      courier_zone: null,
      delivery_zone: null,
      delivery_source: null,
      local_shiprocket_pending_at: null,
    };
  }

  const courierZone = quote?.courier_zone || null;
  const zone = quote?.zone || (courierZone === 'local' ? 'intra_city' : 'outstation');
  const isLocal = courierZone === 'local' || zone === 'intra_city';
  const provider = normalizeShippingProvider(restaurant?.shipping_provider);
  const shipOk = provider !== 'custom' && hasShiprocketCreds(restaurant);

  let channel = String(deliveryChannel || '').toLowerCase();
  if (provider === 'custom') {
    channel = 'custom';
  } else if (!isLocal) {
    channel = 'shiprocket';
  } else if (channel !== 'shiprocket' && channel !== 'own_team') {
    channel = 'own_team';
  }
  if (channel === 'shiprocket' && !shipOk && isLocal) {
    channel = 'own_team';
  }

  const needsManager = isLocal && channel === 'shiprocket' && shipOk;
  const resolvedOwnMode = (channel === 'own_team' || channel === 'custom')
    ? normalizeOwnTeamMode(ownTeamMode)
    : null;

  return {
    fulfillment_type: 'delivery',
    service_type: 'delivery',
    delivery_channel: channel,
    delivery_channel_requested: channel,
    delivery_channel_status: needsManager ? 'pending_manager' : 'confirmed',
    own_team_mode: resolvedOwnMode,
    courier_zone: courierZone,
    delivery_zone: zone,
    delivery_source: quote?.source
      || (channel === 'own_team' ? 'intra_city_flat' : channel === 'custom' ? 'custom' : 'shiprocket'),
    shipping_provider: provider,
    local_shiprocket_pending_at: needsManager ? new Date().toISOString() : null,
  };
}

function isLocalShiprocketPending(meta = {}) {
  return String(meta.delivery_channel_status || '') === 'pending_manager'
    && String(meta.delivery_channel || '') === 'shiprocket';
}

function pendingTimedOut(meta = {}, hours = LOCAL_CHANNEL_PENDING_HOURS) {
  const raw = meta.local_shiprocket_pending_at;
  if (!raw) return false;
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) >= hours * 60 * 60 * 1000;
}

/**
 * Whether packing completion should create a Shiprocket shipment.
 */
function shouldCreateShiprocketForMeta(meta = {}) {
  if (String(meta.fulfillment_type || '').toLowerCase() === 'pickup') return false;
  const svc = String(meta.service_type || '').toLowerCase();
  if (svc === 'takeaway' && String(meta.fulfillment_type || '') !== 'delivery') {
    return false;
  }
  const channel = String(meta.delivery_channel || '').toLowerCase();
  if (channel === 'own_team' || channel === 'custom') return false;
  if (channel === 'shiprocket') {
    const status = String(meta.delivery_channel_status || 'confirmed');
    if (status === 'pending_manager') return false;
    return status === 'confirmed' || status === 'auto_accepted';
  }
  // Legacy bookings without channel meta: keep prior auto behavior for delivery.
  return true;
}

function chargeForChannel(quote, deliveryChannel) {
  const options = Array.isArray(quote?.channel_options) ? quote.channel_options : [];
  const wanted = String(deliveryChannel || '').toLowerCase();
  if (wanted && options.length) {
    const hit = options.find((o) => String(o.delivery_channel) === wanted);
    if (hit) return Number(hit.charge || 0);
  }
  return Number(quote?.charge || 0);
}

module.exports = {
  LOCAL_CHANNEL_PENDING_HOURS,
  SHIPPED_LOBS,
  OWN_TEAM_MODES,
  hasShiprocketCreds,
  packagedServicesEnabled,
  isShippedLob,
  normalizeOwnTeamMode,
  needsShipmentDetailsBeforeNotify,
  buildFulfillmentMeta,
  isLocalShiprocketPending,
  pendingTimedOut,
  shouldCreateShiprocketForMeta,
  chargeForChannel,
  normalizePincode,
  resolveCourierZone,
};
