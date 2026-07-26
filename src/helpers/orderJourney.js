'use strict';

/**
 * Order journey rows for packaged LOBs: Prep → Packing → Shipment → Delivered.
 */

const { supabaseAdmin } = require('../config/supabase');
const { shipmentPayloadFromMeta, shouldAutoCreateShiprocket } = require('./shiprocketShipment');
const {
  shouldCreateShiprocketForMeta,
  isLocalShiprocketPending,
} = require('./fulfillmentChannels');

const ACTIVE_TOKEN_STATUSES = new Set([
  'waiting', 'seated', 'takeaway', 'delivery', 'pending_approval', 'preparing', 'ready',
]);

function trackUrlFromMeta(meta = {}) {
  if (meta.tracking_url) return String(meta.tracking_url);
  const awb = String(meta.awb || '').trim();
  if (!awb) return null;
  return `https://shiprocket.co/tracking/${encodeURIComponent(awb)}`;
}

function normalizeOpsMode(raw) {
  return String(raw || 'combined').toLowerCase() === 'split' ? 'split' : 'combined';
}

function deriveStage({ cooking, packing, meta, serviceType }) {
  const m = meta || {};
  const fulfillment = String(m.fulfillment_type || '').toLowerCase();
  const channel = String(m.delivery_channel || '').toLowerCase();
  const shipStatus = String(m.shipment_status || '').toLowerCase().replace(/\s+/g, '_');
  const svc = String(serviceType || m.service_type || '').toLowerCase();

  if (shipStatus.includes('deliver') && !shipStatus.includes('undeliver')) {
    return 'delivered';
  }
  if (
    shipStatus.includes('out_for_delivery')
    || shipStatus.includes('in_transit')
    || shipStatus.includes('shipped')
    || shipStatus.includes('picked_up')
  ) {
    return 'out_for_delivery';
  }
  if (m.awb) return 'shipped';

  const cookingOpen = (cooking || []).some((i) => i.status !== 'ready' && i.status !== 'cancelled');
  const packingLines = packing || [];
  const packingOpen = packingLines.length > 0
    && packingLines.some((i) => i.status !== 'ready' && i.status !== 'cancelled');
  const packingDone = packingLines.length > 0
    && packingLines.every((i) => i.status === 'ready' || i.status === 'cancelled');

  if (cookingOpen) return 'prep';
  if (packingOpen) return 'packing';

  if (fulfillment === 'pickup' || (svc.includes('takeaway') && fulfillment !== 'delivery')) {
    return packingDone || packingLines.length === 0 ? 'pickup' : 'packing';
  }
  if (channel === 'own_team') {
    return packingDone || packingLines.length === 0 ? 'own_team' : 'packing';
  }
  if (isLocalShiprocketPending(m)) return 'awaiting_courier';
  if (m.shiprocket_order_id) return 'awaiting_courier';
  if (packingDone) return 'awaiting_courier';
  // Live token with no KDS lines yet — treat as prep.
  return packingLines.length ? 'packing' : 'prep';
}

function skipReasonFor({ meta, restaurant, serviceType }) {
  const m = meta || {};
  if (String(m.fulfillment_type || '').toLowerCase() === 'pickup') return 'pickup_or_takeaway';
  const svc = String(serviceType || m.service_type || '').toLowerCase();
  if (svc.includes('takeaway') && String(m.fulfillment_type || '') !== 'delivery') {
    return 'pickup_or_takeaway';
  }
  if (String(m.delivery_channel || '').toLowerCase() === 'own_team') return 'own_team';
  if (isLocalShiprocketPending(m)) return 'pending_manager';
  if (!shouldCreateShiprocketForMeta(m)) return 'channel_blocked';
  const gate = shouldAutoCreateShiprocket({
    restaurant,
    booking: { meta: m, service_type: serviceType, delivery_address: m.delivery_address },
  });
  if (!gate.ok) return gate.reason;
  if (m.shiprocket_last_error && !m.awb) return 'shiprocket_error';
  return null;
}

/**
 * Build journey rows for a restaurant's live packaged orders.
 */
async function buildOrderJourney({ restaurantId, restaurant = null }) {
  const { data: tokens, error: tokenErr } = await supabaseAdmin
    .from('walk_in_tokens')
    .select('id, name, phone, type, status, pax, arrived_at, meta')
    .eq('restaurant_id', restaurantId)
    .in('status', [...ACTIVE_TOKEN_STATUSES])
    .order('arrived_at', { ascending: false })
    .limit(80);
  if (tokenErr) throw tokenErr;

  const live = (tokens || []).filter((t) => {
    const typ = String(t.type || '').toLowerCase();
    const st = String(t.status || '').toLowerCase();
    return ['takeaway', 'delivery', 'scheduled_takeaway', 'scheduled_delivery', 'queue'].includes(typ)
      || st === 'takeaway'
      || st === 'delivery';
  });

  if (!live.length) return [];

  const tokenIds = live.map((t) => t.id);
  const { data: kdsItems, error: kdsErr } = await supabaseAdmin
    .from('kds_items')
    .select('id, status, queue, token_number, name, quantity, service_type, created_at, order_item:order_item_id!left(order:order_id!left(order_number, total_amount))')
    .eq('restaurant_id', restaurantId)
    .in('token_number', tokenIds);
  if (kdsErr) throw kdsErr;

  const { data: bookings, error: bookErr } = await supabaseAdmin
    .from('bookings')
    .select('id, token_number, order_ref, customer_name, customer_phone, service_type, delivery_address, meta, created_at, status')
    .eq('restaurant_id', restaurantId)
    .in('token_number', tokenIds);
  if (bookErr) throw bookErr;

  const kdsByToken = new Map();
  for (const item of kdsItems || []) {
    const key = String(item.token_number || '');
    if (!kdsByToken.has(key)) kdsByToken.set(key, []);
    kdsByToken.get(key).push(item);
  }
  const bookingByToken = new Map();
  for (const b of bookings || []) {
    bookingByToken.set(String(b.token_number || ''), b);
  }

  let rest = restaurant;
  if (!rest) {
    const { data } = await supabaseAdmin
      .from('tenants')
      .select('id, lob_type, shipping_provider, shiprocket_email, shiprocket_api_key, shiprocket_connected, postal_code, order_ops_mode')
      .eq('id', restaurantId)
      .maybeSingle();
    rest = data;
  }

  return live.map((token) => {
    const items = kdsByToken.get(String(token.id)) || [];
    const cooking = items.filter((i) => String(i.queue || 'cooking') === 'cooking');
    const packing = items.filter((i) => String(i.queue || '') === 'packing');
    const booking = bookingByToken.get(String(token.id)) || null;
    const meta = {
      ...(token.meta || {}),
      ...(booking?.meta || {}),
    };
    const serviceType = booking?.service_type
      || items[0]?.service_type
      || token.type
      || meta.service_type;
    const stage = deriveStage({ cooking, packing, meta, serviceType });
    const shipment = shipmentPayloadFromMeta(meta);
    const orderNumber = items[0]?.order_item?.order?.order_number
      || booking?.order_ref
      || null;
    const itemLines = items.map((i) => ({
      name: i.name,
      qty: i.quantity || 1,
      status: i.status,
      queue: i.queue || 'cooking',
    }));

    const skip = (!shipment.shiprocket_order_id && !shipment.awb)
      ? skipReasonFor({ meta, restaurant: rest, serviceType })
      : (shipment.shiprocket_last_error && !shipment.awb ? 'shiprocket_error' : null);

    return {
      token_number: token.id,
      customer_name: booking?.customer_name || token.name || null,
      customer_phone: booking?.customer_phone || token.phone || null,
      order_ref: booking?.order_ref || orderNumber,
      order_number: orderNumber,
      service_type: serviceType,
      token_type: token.type,
      token_status: token.status,
      arrived_at: token.arrived_at,
      booking_id: booking?.id || null,
      stage,
      items: itemLines,
      fulfillment_type: meta.fulfillment_type || null,
      delivery_channel: meta.delivery_channel || null,
      delivery_channel_status: meta.delivery_channel_status || null,
      shipment: {
        ...shipment,
        tracking_url: trackUrlFromMeta(meta),
      },
      skip_reason: skip,
      shiprocket_error: meta.shiprocket_last_error || null,
    };
  });
}

module.exports = {
  buildOrderJourney,
  deriveStage,
  normalizeOpsMode,
  trackUrlFromMeta,
  skipReasonFor,
};
