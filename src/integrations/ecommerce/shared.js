'use strict';

/**
 * Shared helpers for ecommerce order push.
 */

const ECOMMERCE_PROVIDERS = Object.freeze([
  'shopify',
  'woocommerce',
  'wix',
  'dukaan',
  'instamojo',
  'webhook',
  'ondc',
]);

const PROVIDER_LABELS = Object.freeze({
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  wix: 'Wix',
  dukaan: 'Dukaan',
  instamojo: 'Instamojo',
  webhook: 'Other (webhook)',
  ondc: 'ONDC',
});

function normalizeProvider(value) {
  const key = String(value || '').trim().toLowerCase();
  return ECOMMERCE_PROVIDERS.includes(key) ? key : null;
}

function normalizeStoreUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return s;
}

function storeBaseUrl(raw) {
  const host = normalizeStoreUrl(raw);
  if (!host) return '';
  if (/^https?:\/\//i.test(String(raw || '').trim())) {
    return String(raw).trim().replace(/\/+$/, '');
  }
  return `https://${host}`;
}

function isDineInService(serviceType) {
  const s = String(serviceType || '').toLowerCase();
  return s === 'dine_in' || s === 'dine-in' || s === 'dining' || s === 'table';
}

/**
 * Build a normalized order snapshot from a bookings row + optional items override.
 */
function buildOrderSnapshot(booking, itemsOverride) {
  const meta = (booking && typeof booking.meta === 'object' && booking.meta) || {};
  const scheduleMeta = (booking && typeof booking.schedule_meta === 'object' && booking.schedule_meta) || {};
  const web = meta.web_cart_submission || scheduleMeta.web_cart_submission || {};
  const prepay = meta.prepay_fulfillment_payload || scheduleMeta.prepay_fulfillment_payload || {};

  let items = Array.isArray(itemsOverride) ? itemsOverride : null;
  if (!items || !items.length) {
    const raw =
      web.items
      || prepay.items
      || meta.items
      || scheduleMeta.items
      || null;
    if (Array.isArray(raw)) {
      items = raw.map((it) => ({
        name: String(it.name || it.title || it.item_name || 'Item').trim() || 'Item',
        quantity: Math.max(1, Number(it.quantity ?? it.qty ?? 1) || 1),
        unit_price: Number(
          it.unit_price ?? it.price ?? it.unitPrice ?? 0,
        ) || 0,
      }));
    } else if (meta.cart && typeof meta.cart === 'object') {
      items = Object.values(meta.cart).map((line) => {
        if (!line || typeof line !== 'object') return null;
        return {
          name: String(line.name || line.title || 'Item').trim() || 'Item',
          quantity: Math.max(1, Number(line.qty || line.quantity || 1) || 1),
          unit_price: Number(line.unit_price || line.price || 0) || 0,
        };
      }).filter(Boolean);
    } else {
      items = [];
    }
  }

  const customerName = String(
    booking.customer_name
    || web.customer_name
    || web.name
    || meta.customer_name
    || 'Guest',
  ).trim() || 'Guest';
  const phoneRaw = String(
    booking.customer_phone
    || web.customer_phone
    || web.phone
    || meta.customer_phone
    || '',
  ).replace(/\D/g, '');

  const total = Number(
    web.total
    ?? web.grand_total
    ?? scheduleMeta.total
    ?? (scheduleMeta.totals && scheduleMeta.totals.grand_total)
    ?? meta.total
    ?? booking.order_subtotal
    ?? items.reduce((s, i) => s + i.quantity * i.unit_price, 0),
  ) || 0;

  const delivery = Number(web.delivery_charge ?? meta.delivery_charge ?? 0) || 0;
  const tax = Number(web.gst_amount ?? meta.gst_amount ?? 0) || 0;
  const token = booking.token_number != null ? String(booking.token_number) : null;
  const orderRef = String(
    booking.order_ref
    || web.order_ref
    || meta.order_ref
    || '',
  ).trim() || null;

  const noteParts = [];
  if (token) noteParts.push(`Token ${token}`);
  if (orderRef) noteParts.push(orderRef);
  noteParts.push('Munafe WhatsApp / webcart order');

  return {
    booking_id: booking.id,
    restaurant_id: booking.restaurant_id,
    service_type: booking.service_type || web.service_type || null,
    token_number: token,
    order_ref: orderRef,
    note: noteParts.join(' | '),
    customer: {
      name: customerName,
      first_name: customerName.split(/\s+/)[0] || customerName,
      phone: phoneRaw,
      phone_e164: phoneRaw
        ? (phoneRaw.startsWith('91') && phoneRaw.length >= 12
          ? `+${phoneRaw}`
          : (phoneRaw.length === 10 ? `+91${phoneRaw}` : `+${phoneRaw}`))
        : null,
    },
    items,
    subtotal: Math.max(0, total - delivery - tax),
    delivery,
    tax,
    total,
    address: String(
      booking.delivery_address
      || web.delivery_address
      || web.address
      || meta.delivery_address
      || '',
    ).trim() || null,
    timestamp: new Date().toISOString(),
  };
}

function alreadyPushedProvider(booking, provider) {
  const meta = (booking && typeof booking.meta === 'object' && booking.meta) || {};
  const pushes = Array.isArray(meta.ecommerce_pushes) ? meta.ecommerce_pushes : [];
  return pushes.some(
    (p) => p
      && String(p.provider).toLowerCase() === String(provider).toLowerCase()
      && String(p.status || '').toLowerCase() === 'success',
  );
}

module.exports = {
  ECOMMERCE_PROVIDERS,
  PROVIDER_LABELS,
  normalizeProvider,
  normalizeStoreUrl,
  storeBaseUrl,
  isDineInService,
  buildOrderSnapshot,
  alreadyPushedProvider,
};
