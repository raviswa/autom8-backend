'use strict';

/**
 * Create / retry Shiprocket shipments for packed delivery bookings.
 * Persists AWB + status on bookings.meta for packing UI + inbound webhooks.
 */

const { supabaseAdmin } = require('../config/supabase');
const { createShiprocketOrder, assignShiprocketAwb } = require('./shiprocket');
const { cartWeightKg, resolveCartLineWeights } = require('./cartWeight');
const { normalizeShippingProvider } = require('./courierRates');
const { isPackagedLob } = require('./kdsQueue');

const SHIPPED_LOBS = new Set(['food_products', 'retail', 'psl', 'b2b']);

function digitsOnly(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function normalizePincode(raw) {
  const d = digitsOnly(raw);
  return d.length >= 6 ? d.slice(0, 6) : '';
}

function parsePincodeFromAddress(address) {
  const match = String(address || '').match(/\b(\d{6})\b/);
  return match ? match[1] : '';
}

function shipmentPayloadFromMeta(meta = {}) {
  return {
    shiprocket_order_id: meta.shiprocket_order_id || null,
    shiprocket_shipment_id: meta.shiprocket_shipment_id || null,
    awb: meta.awb || null,
    courier_name: meta.courier_name || null,
    shipment_status: meta.shipment_status || null,
    shiprocket_last_error: meta.shiprocket_last_error || null,
    shipment_mode: meta.shipment_mode || null,
    tracking_url: meta.tracking_url || null,
    shipping_provider: meta.shipping_provider || null,
    delivery_channel: meta.delivery_channel || null,
  };
}

function tokenVariants(tokenRaw) {
  const raw = String(tokenRaw || '').trim();
  if (!raw) return [];
  const upper = raw.toUpperCase();
  const digits = upper.replace(/^T-/i, '');
  const variants = new Set([raw, upper, `T-${digits}`, digits]);
  return [...variants].filter(Boolean);
}

/**
 * Resolve a booking for a packed KDS order (token / phone / order_ref).
 */
async function resolveBookingForPackedOrder({ restaurantId, tokenNumber, customerPhone, orderNumber }) {
  const tokens = tokenVariants(tokenNumber);
  if (tokens.length) {
    const { data: byTokenRows } = await supabaseAdmin
      .from('bookings')
      .select('id, restaurant_id, customer_phone, customer_name, order_ref, delivery_address, meta, service_type, token_number, created_at, payment_status')
      .eq('restaurant_id', restaurantId)
      .in('token_number', tokens)
      .order('created_at', { ascending: false })
      .limit(1);
    if (byTokenRows?.[0]) return byTokenRows[0];

    const { data: portalRows } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('id, meta, created_at')
      .eq('restaurant_id', restaurantId)
      .in('id', tokens)
      .order('created_at', { ascending: false })
      .limit(1);
    const bid = portalRows?.[0]?.meta?.booking_id;
    if (bid) {
      const { data: fromPortal } = await supabaseAdmin
        .from('bookings')
        .select('id, restaurant_id, customer_phone, customer_name, order_ref, delivery_address, meta, service_type, token_number, created_at, payment_status')
        .eq('id', bid)
        .eq('restaurant_id', restaurantId)
        .maybeSingle();
      if (fromPortal) return fromPortal;
    }
  }

  if (orderNumber) {
    const { data: byRefRows } = await supabaseAdmin
      .from('bookings')
      .select('id, restaurant_id, customer_phone, customer_name, order_ref, delivery_address, meta, service_type, token_number, created_at, payment_status')
      .eq('restaurant_id', restaurantId)
      .eq('order_ref', String(orderNumber))
      .order('created_at', { ascending: false })
      .limit(1);
    if (byRefRows?.[0]) return byRefRows[0];
  }

  const phone = digitsOnly(customerPhone).slice(-10);
  if (phone.length === 10) {
    const { data: byPhoneRows } = await supabaseAdmin
      .from('bookings')
      .select('id, restaurant_id, customer_phone, customer_name, order_ref, delivery_address, meta, service_type, token_number, created_at, payment_status')
      .eq('restaurant_id', restaurantId)
      .ilike('customer_phone', `%${phone}`)
      .order('created_at', { ascending: false })
      .limit(1);
    if (byPhoneRows?.[0]) return byPhoneRows[0];
  }

  return null;
}

async function loadRestaurantShipCreds(restaurantId) {
  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select(`
      id, name, display_name, contact_phone, whatsapp_number, postal_code,
      city, state, pickup_address, lob_type, shipping_provider,
      shiprocket_email, shiprocket_api_key, shiprocket_connected,
      packaging_weight_grams, gstin
    `)
    .eq('id', restaurantId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function buildOrderItemsFromBooking(booking, menuRows, packagingGrams) {
  const meta = booking.meta || {};
  const cart = meta.web_cart_submission?.items || meta.cart || meta.items || [];
  let lines = [];

  if (Array.isArray(cart) && cart.length) {
    const weighted = resolveCartLineWeights(cart, menuRows || []);
    lines = weighted.map((l, idx) => {
      const src = (menuRows || []).find(
        (m) => String(m.id) === String(l.id) || String(m.retailer_id) === String(l.id),
      );
      const qty = Math.max(1, Number(l.qty || l.quantity || 1) || 1);
      const price = Number(l.price ?? src?.price ?? 0) || 0;
      return {
        name: String(l.name || src?.name || 'Item').slice(0, 200),
        sku: String(src?.retailer_id || l.id || `sku-${idx + 1}`).slice(0, 50),
        units: qty,
        selling_price: price,
        weight_grams: Number(l.weight_grams || src?.weight_grams || 0) || 0,
      };
    });
  }

  if (!lines.length) {
    lines = [{ name: 'Order items', sku: 'ORDER', units: 1, selling_price: 1, weight_grams: 500 }];
  }

  const weightKg = Math.max(
    0.1,
    cartWeightKg(
      lines.map((l) => ({ qty: l.units, weight_grams: l.weight_grams })),
      { packagingGrams: packagingGrams || 0 },
    ) || 0.5,
  );

  const orderItems = lines.map((l) => ({
    name: l.name,
    sku: l.sku,
    units: l.units,
    selling_price: Math.max(1, Math.round(l.selling_price) || 1),
  }));

  const subTotal = orderItems.reduce((sum, row) => sum + row.selling_price * row.units, 0);

  return { orderItems, subTotal: Math.max(1, subTotal), weightKg };
}

function splitCustomerName(fullName) {
  const parts = String(fullName || 'Customer').trim().split(/\s+/).filter(Boolean);
  return {
    first: parts[0] || 'Customer',
    last: parts.length > 1 ? parts.slice(1).join(' ') : '',
  };
}

function shouldAutoCreateShiprocket({ restaurant, booking }) {
  if (!restaurant) return { ok: false, reason: 'restaurant_missing' };
  const lob = String(restaurant.lob_type || '').toLowerCase();
  const provider = normalizeShippingProvider(restaurant.shipping_provider);
  const hasCreds = !!(
    String(restaurant.shiprocket_email || '').trim()
    && String(restaurant.shiprocket_api_key || '').trim()
  );
  if (!hasCreds && !restaurant.shiprocket_connected) {
    return { ok: false, reason: 'shiprocket_not_connected' };
  }
  // Prefer Shiprocket when provider is shiprocket / default, or packaged LOB with creds.
  if (provider === 'custom') return { ok: false, reason: 'custom_courier' };
  if (!SHIPPED_LOBS.has(lob) && !isPackagedLob(lob)) {
    const svc = String(booking?.service_type || booking?.meta?.service_type || '').toLowerCase();
    if (!svc.includes('delivery')) return { ok: false, reason: 'not_delivery' };
  }
  const addr = String(booking?.delivery_address || booking?.meta?.delivery_address || '').trim();
  const pin = normalizePincode(
    booking?.meta?.pincode
      || booking?.meta?.delivery_pincode
      || parsePincodeFromAddress(addr),
  );
  if (!addr || !pin) return { ok: false, reason: 'missing_delivery_address' };
  return { ok: true, reason: null };
}

async function persistBookingShipmentMeta(bookingId, patch) {
  const { data: current, error: readErr } = await supabaseAdmin
    .from('bookings')
    .select('id, meta')
    .eq('id', bookingId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!current) throw new Error('Booking not found');

  const nextMeta = {
    ...(current.meta || {}),
    ...patch,
  };
  const { data: updated, error } = await supabaseAdmin
    .from('bookings')
    .update({ meta: nextMeta })
    .eq('id', bookingId)
    .select('id, meta')
    .single();
  if (error) throw error;
  return updated;
}

/**
 * Create Shiprocket order + assign AWB for a booking. Idempotent if AWB already present
 * unless force=true (retry).
 */
async function createOrRetryShiprocketShipment({ restaurantId, bookingId, force = false }) {
  const { data: booking, error: bookingErr } = await supabaseAdmin
    .from('bookings')
    .select('id, restaurant_id, customer_phone, customer_name, order_ref, delivery_address, meta, service_type, token_number, created_at, payment_status')
    .eq('id', bookingId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle();
  if (bookingErr) throw bookingErr;
  if (!booking) return { ok: false, error: 'Booking not found', shipment: null };

  const existing = shipmentPayloadFromMeta(booking.meta || {});
  if (existing.awb && !force) {
    return { ok: true, skipped: true, reason: 'already_has_awb', shipment: existing, booking_id: booking.id };
  }

  const restaurant = await loadRestaurantShipCreds(restaurantId);
  const {
    shouldCreateShiprocketForMeta,
  } = require('./fulfillmentChannels');
  if (!shouldCreateShiprocketForMeta(booking.meta || {}) && !force) {
    return {
      ok: false,
      skipped: true,
      reason: 'channel_not_shiprocket',
      shipment: existing,
      booking_id: booking.id,
    };
  }
  const gate = shouldAutoCreateShiprocket({ restaurant, booking });
  if (!gate.ok && !force) {
    return { ok: false, skipped: true, reason: gate.reason, shipment: existing, booking_id: booking.id };
  }

  const meta = booking.meta || {};
  const address = String(booking.delivery_address || meta.delivery_address || '').trim();
  const pincode = normalizePincode(
    meta.pincode || meta.delivery_pincode || parsePincodeFromAddress(address),
  );
  const pickupPin = normalizePincode(restaurant?.postal_code);
  if (!address || !pincode) {
    const err = 'Delivery address / pincode missing for Shiprocket.';
    await persistBookingShipmentMeta(booking.id, {
      shiprocket_last_error: err,
      shipment_status: 'create_failed',
      shipment_mode: 'shiprocket',
    });
    return { ok: false, error: err, shipment: shipmentPayloadFromMeta({ ...existing, shiprocket_last_error: err, shipment_status: 'create_failed' }), booking_id: booking.id };
  }

  const { data: menuRows } = await supabaseAdmin
    .from('menu_items')
    .select('id, retailer_id, name, weight_grams, pack_size_label, size_label, price')
    .eq('restaurant_id', restaurantId)
    .is('archived_at', null);

  const { orderItems, subTotal, weightKg } = buildOrderItemsFromBooking(
    booking,
    menuRows || [],
    restaurant?.packaging_weight_grams,
  );

  const { first, last } = splitCustomerName(booking.customer_name || meta.customer_name);
  const phone = digitsOnly(booking.customer_phone || meta.customer_phone).slice(-10) || '9999999999';
  const channelOrderId = String(booking.order_ref || booking.token_number || booking.id)
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 50) || String(booking.id).slice(0, 50);

  const orderDate = new Date(booking.created_at || Date.now())
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');

  const city = String(meta.city || meta.delivery_city || restaurant?.city || 'City').slice(0, 30);
  const state = String(meta.state || meta.delivery_state || restaurant?.state || 'State').slice(0, 50);
  const email = String(meta.email || meta.customer_email || 'orders@autom8.works').trim();
  const paymentMethod = String(booking.payment_status || '').toLowerCase() === 'cod' ? 'COD' : 'Prepaid';

  // Shiprocket pickup nickname must already exist in the merchant account (default "Primary").
  const pickupLocation = String(
    meta.shiprocket_pickup_location
      || restaurant?.shiprocket_pickup_location
      || 'Primary',
  ).trim() || 'Primary';

  const createPayload = {
    order_id: force && existing.shiprocket_order_id
      ? `${channelOrderId}-R${Date.now().toString().slice(-4)}`
      : channelOrderId,
    order_date: orderDate,
    pickup_location: pickupLocation,
    billing_customer_name: first,
    billing_last_name: last,
    billing_address: address.slice(0, 190),
    billing_city: city,
    billing_pincode: Number(pincode),
    billing_state: state,
    billing_country: 'India',
    billing_email: email,
    billing_phone: Number(phone),
    shipping_is_billing: true,
    order_items: orderItems,
    payment_method: paymentMethod,
    sub_total: subTotal,
    length: 10,
    breadth: 10,
    height: 10,
    weight: weightKg,
  };

  const creds = {
    email: restaurant.shiprocket_email,
    password: restaurant.shiprocket_api_key,
    apiKey: restaurant.shiprocket_api_key,
  };

  const created = await createShiprocketOrder({ ...creds, payload: createPayload });
  if (!created.ok) {
    await persistBookingShipmentMeta(booking.id, {
      shiprocket_last_error: created.error,
      shipment_status: 'create_failed',
      shipment_mode: 'shiprocket',
    });
    return {
      ok: false,
      error: created.error,
      shipment: shipmentPayloadFromMeta({
        ...existing,
        shiprocket_last_error: created.error,
        shipment_status: 'create_failed',
        shipment_mode: 'shiprocket',
      }),
      booking_id: booking.id,
    };
  }

  let awb = null;
  let courierName = null;
  let awbError = null;
  if (created.shipmentId) {
    const assigned = await assignShiprocketAwb({
      ...creds,
      shipmentId: created.shipmentId,
    });
    if (assigned.ok) {
      awb = assigned.awb;
      courierName = assigned.courierName || 'Shiprocket';
    } else {
      awbError = assigned.error;
    }
  }

  const patch = {
    shiprocket_order_id: String(created.orderId || ''),
    shiprocket_shipment_id: created.shipmentId ? String(created.shipmentId) : null,
    awb: awb || null,
    courier_name: courierName || existing.courier_name || 'Shiprocket',
    shipment_status: awb ? 'awb_assigned' : (awbError ? 'awb_failed' : 'created'),
    shiprocket_last_error: awbError || null,
    shipment_mode: 'shiprocket',
    pickup_pincode: pickupPin || null,
  };

  const updated = await persistBookingShipmentMeta(booking.id, patch);
  return {
    ok: !awbError || !!awb,
    error: awbError || null,
    shipment: shipmentPayloadFromMeta(updated.meta || patch),
    booking_id: booking.id,
    raw_create: created.raw,
  };
}

/**
 * After packing queue lines are all ready — auto-create Shiprocket if applicable.
 */
async function maybeCreateShiprocketOnPackingComplete({
  restaurantId,
  tokenNumber,
  customerPhone,
  orderNumber,
  serviceType,
}) {
  try {
    const {
      shouldCreateShiprocketForMeta,
      isLocalShiprocketPending,
      pendingTimedOut,
    } = require('./fulfillmentChannels');

    let booking = await resolveBookingForPackedOrder({
      restaurantId,
      tokenNumber,
      customerPhone,
      orderNumber,
    });
    if (!booking) {
      console.warn('[shiprocketShipment] No booking found for packed order', { tokenNumber, orderNumber });
      return { ok: false, reason: 'booking_not_found' };
    }

    let meta = booking.meta || {};

    // Prefer delivery / shipped LOBs; skip pure takeaway / store pickup.
    const fulfillment = String(meta.fulfillment_type || '').toLowerCase();
    const svc = String(serviceType || booking.service_type || meta.service_type || '').toLowerCase();
    if (fulfillment === 'pickup' || (svc.includes('takeaway') && fulfillment !== 'delivery')) {
      return { ok: false, reason: 'pickup_or_takeaway', booking_id: booking.id };
    }

    // Auto-accept same-city Shiprocket request after SLA timeout.
    if (isLocalShiprocketPending(meta) && pendingTimedOut(meta)) {
      const updated = await persistBookingShipmentMeta(booking.id, {
        delivery_channel: 'shiprocket',
        delivery_channel_status: 'auto_accepted',
        local_shiprocket_pending_at: null,
      });
      meta = updated.meta || meta;
      booking = { ...booking, meta };
    }

    if (!shouldCreateShiprocketForMeta(meta)) {
      return {
        ok: false,
        skipped: true,
        reason: isLocalShiprocketPending(meta)
          ? 'pending_manager'
          : (String(meta.delivery_channel || '') === 'own_team' ? 'own_team' : 'channel_blocked'),
        booking_id: booking.id,
        shipment: shipmentPayloadFromMeta(meta),
      };
    }

    if (meta.awb) {
      return {
        ok: true,
        skipped: true,
        reason: 'already_has_awb',
        booking_id: booking.id,
        shipment: shipmentPayloadFromMeta(meta),
      };
    }

    return await createOrRetryShiprocketShipment({
      restaurantId,
      bookingId: booking.id,
      force: false,
    });
  } catch (err) {
    console.error('[shiprocketShipment] maybeCreate failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  shipmentPayloadFromMeta,
  resolveBookingForPackedOrder,
  createOrRetryShiprocketShipment,
  maybeCreateShiprocketOnPackingComplete,
  shouldAutoCreateShiprocket,
  persistBookingShipmentMeta,
};
