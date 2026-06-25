// Resolve scanned QR / token text → orders.id for captain takeaway collection.

'use strict';

const { supabaseAdmin } = require('../config/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse camera / wedge scan into order UUID or portal token. */
function parseQrScanInput(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;

  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = `${u.pathname}${u.search || ''}`;
    } catch (_) {
      // keep original string
    }
  }

  const verifyMatch = s.match(/\/verify\/([^/?#]+)/i);
  if (verifyMatch) return { type: 'order_id', value: verifyMatch[1] };

  const receiptMatch = s.match(/\/r\/([^/?#]+)/i);
  if (receiptMatch) return { type: 'token', value: decodeURIComponent(receiptMatch[1]) };

  if (UUID_RE.test(s)) return { type: 'order_id', value: s };

  return { type: 'token', value: s.replace(/^#/, '').trim() };
}

function tokenSuffix(token) {
  return String(token || '').replace(/^#/, '').replace(/^T-/i, '').trim();
}

/** Build walk-in / booking token variants (T-001, #097, T-2606-127, …). */
function buildTokenVariants(token) {
  const raw = String(token || '').trim();
  if (!raw) return [];

  const variants = new Set([raw, raw.toUpperCase()]);
  const noHash = raw.replace(/^#/, '');
  variants.add(noHash);
  variants.add(`#${noHash}`);

  const digits = noHash.replace(/^T-/i, '');
  variants.add(digits);
  variants.add(`T-${digits}`);
  variants.add(`#${digits}`);

  if (/^\d+$/.test(digits)) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: '2-digit',
      month: '2-digit',
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value || '';
    const monthKey = `${get('year')}${get('month')}`;
    variants.add(`T-${monthKey}-${digits.padStart(3, '0')}`);
  }

  return [...variants].filter(Boolean);
}

async function findOrderByNumberPatterns(restaurantId, suffixes) {
  for (const suffix of suffixes) {
    const { data: exact } = await supabaseAdmin
      .from('orders')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('order_number', `ORD-${suffix}`)
      .maybeSingle();
    if (exact?.id) return exact.id;
  }

  for (const suffix of suffixes) {
    const { data: rows } = await supabaseAdmin
      .from('orders')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .like('order_number', `ORD-${suffix}%`)
      .order('created_at', { ascending: false })
      .limit(1);
    if (rows?.[0]?.id) return rows[0].id;
  }

  return null;
}

async function findOrderViaBooking(restaurantId, variants, suffixes) {
  const { data: bookings } = await supabaseAdmin
    .from('bookings')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .in('token_number', variants)
    .order('created_at', { ascending: false })
    .limit(1);

  const booking = bookings?.[0];
  if (!booking?.id) return null;

  const { data: orderItems } = await supabaseAdmin
    .from('order_items')
    .select('order_id')
    .eq('booking_id', booking.id)
    .order('created_at', { ascending: false })
    .limit(1);
  if (orderItems?.[0]?.order_id) return orderItems[0].order_id;

  const bidShort = String(booking.id).replace(/-/g, '').slice(0, 8);
  for (const suffix of suffixes) {
    const { data: rows } = await supabaseAdmin
      .from('orders')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .like('order_number', `ORD-${suffix}-${bidShort}%`)
      .order('created_at', { ascending: false })
      .limit(1);
    if (rows?.[0]?.id) return rows[0].id;
  }

  return null;
}

async function findOrderViaKdsToken(restaurantId, variants) {
  const { data: kdsRows } = await supabaseAdmin
    .from('kds_items')
    .select('order_item:order_item_id(order_id)')
    .eq('restaurant_id', restaurantId)
    .in('token_number', variants)
    .order('created_at', { ascending: false })
    .limit(5);

  for (const row of kdsRows ?? []) {
    const orderId = row.order_item?.order_id;
    if (orderId) return orderId;
  }
  return null;
}

/**
 * @returns {{ order_id: string } | { error: string }}
 */
async function resolveOrderIdForTakeawayScan(restaurantId, raw) {
  const parsed = parseQrScanInput(raw);
  if (!parsed) return { error: 'Could not read QR code' };

  if (parsed.type === 'order_id') {
    if (!UUID_RE.test(parsed.value)) {
      return { error: 'Invalid order id in QR code' };
    }
    const { data } = await supabaseAdmin
      .from('orders')
      .select('id')
      .eq('id', parsed.value)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (data?.id) return { order_id: data.id };
    return { error: 'Order not found for this QR code' };
  }

  const variants = buildTokenVariants(parsed.value);
  const suffixes = [...new Set(variants.map(tokenSuffix).filter(Boolean))];
  if (!suffixes.length) return { error: 'Could not read QR code' };

  const byOrderNumber = await findOrderByNumberPatterns(restaurantId, suffixes);
  if (byOrderNumber) return { order_id: byOrderNumber };

  const byBooking = await findOrderViaBooking(restaurantId, variants, suffixes);
  if (byBooking) return { order_id: byBooking };

  const byKds = await findOrderViaKdsToken(restaurantId, variants);
  if (byKds) return { order_id: byKds };

  return {
    error: 'No order found for this QR. Ask the customer to show the receipt QR from WhatsApp.',
  };
}

module.exports = {
  parseQrScanInput,
  buildTokenVariants,
  resolveOrderIdForTakeawayScan,
};
