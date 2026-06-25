// Resolve scanned QR / token text → orders.id for captain takeaway collection.

'use strict';

const { supabaseAdmin } = require('../config/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse camera / wedge scan into order UUID or portal token. */
function parseQrScanInput(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;

  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

  const urlMatch = s.match(/https?:\/\/[^"]+/i);
  if (urlMatch) {
    const cleanedUrl = urlMatch[0].replace(/[),.!?]+$/g, '');
    try {
      const u = new URL(cleanedUrl);
      const queryId = u.searchParams.get('id') || u.searchParams.get('order_id') || u.searchParams.get('verify') || u.searchParams.get('token');
      if (queryId && UUID_RE.test(queryId)) {
        return { type: 'order_id', value: queryId };
      }
      s = `${u.pathname}${u.search || ''}`;
    } catch (_) {
      // keep original string
    }
  }

  const verifyMatch = s.match(/\/verify\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i)
    || String(raw).match(/\/verify\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i);
  if (verifyMatch) return { type: 'order_id', value: verifyMatch[1] };

  const receiptMatch = s.match(/\/r\/([^\/?#\s]+)/i)
    || String(raw).match(/\/r\/([^\/?#\s]+)/i);
  if (receiptMatch) return { type: 'token', value: decodeURIComponent(receiptMatch[1]) };

  const ordMatch = String(raw).match(/ORD-(\d+)/i);
  if (ordMatch) return { type: 'token', value: ordMatch[1] };

  const uuidMatch = String(raw).match(UUID_RE);
  if (uuidMatch) return { type: 'order_id', value: uuidMatch[0] };

  const tokenMatch = String(raw).match(/(#T-\d{1,4}|T-\d{1,4}(?:[-\s]*\(?\d{2}[\/\-]\d{2}\)?|\-\d+)?|#\d{1,4})/i);
  if (tokenMatch) return { type: 'token', value: tokenMatch[1].replace(/^#/, '').replace(/^t-/i, 'T-').trim() };

  const token = s.replace(/^(token|order|receipt|code)[:\s]+/i, '').replace(/^#/, '').trim();
  if (token) return { type: 'token', value: token };

  return null;
}

function tokenSuffix(token) {
  return String(token || '').replace(/^#/, '').replace(/^T-/i, '').trim();
}

function parsePortalTokenLabel(raw) {
  const token = String(raw || '').trim().replace(/^#/, '');
  const monthlyIdMatch = token.match(/^T-(\d{4})-(\d+)$/i);
  if (monthlyIdMatch) {
    return { digits: monthlyIdMatch[2], monthKey: monthlyIdMatch[1] };
  }
  const displayLabelMatch = token.match(/^T-(\d+)[-\s]*\(?([0-9]{2})[\/\-]([0-9]{2})\)?$/i);
  if (displayLabelMatch) {
    return { digits: displayLabelMatch[1], monthKey: `${displayLabelMatch[2]}${displayLabelMatch[3]}` };
  }
  return null;
}

/** Build walk-in / booking token variants (T-001, #097, T-2606-127, …). */
function buildTokenVariants(token) {
  const raw = String(token || '').trim();
  if (!raw) return [];

  const normalized = raw.replace(/\s+/g, ' ').trim();
  const upper = normalized.toUpperCase();
  const lower = normalized.toLowerCase();
  const variants = new Set([normalized, upper, lower]);
  const noHash = normalized.replace(/^#/, '').trim();
  variants.add(noHash);
  variants.add(`#${noHash}`);
  variants.add(noHash.toUpperCase());
  variants.add(`#${noHash.toUpperCase()}`);
  variants.add(noHash.toLowerCase());
  variants.add(`#${noHash.toLowerCase()}`);

  const parsedLabel = parsePortalTokenLabel(normalized);
  if (parsedLabel) {
    const { digits, monthKey } = parsedLabel;
    const paddedDigits = String(digits).padStart(3, '0');
    variants.add(digits);
    variants.add(digits.toUpperCase());
    variants.add(digits.toLowerCase());
    variants.add(`T-${digits}`);
    variants.add(`t-${digits}`);
    variants.add(`#${digits}`);
    variants.add(`#${digits.toUpperCase()}`);
    variants.add(`#${digits.toLowerCase()}`);
    variants.add(`T-${monthKey}-${paddedDigits}`);
    variants.add(`t-${monthKey}-${paddedDigits}`);
    variants.add(`T-${paddedDigits}`);
    variants.add(`t-${paddedDigits}`);
  } else {
    const digits = noHash.replace(/^T-/i, '').trim();
    if (digits) {
      variants.add(digits);
      variants.add(digits.toUpperCase());
      variants.add(digits.toLowerCase());
      variants.add(`T-${digits}`);
      variants.add(`t-${digits}`);
      variants.add(`#${digits}`);
      variants.add(`#${digits.toUpperCase()}`);
      variants.add(`#${digits.toLowerCase()}`);
    }

    if (/^\d+$/.test(digits)) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: '2-digit',
        month: '2-digit',
      }).formatToParts(new Date());
      const get = (t) => parts.find((p) => p.type === t)?.value || '';
      const monthKey = `${get('year')}${get('month')}`;
      variants.add(`T-${monthKey}-${digits.padStart(3, '0')}`);
      variants.add(`t-${monthKey}-${digits.padStart(3, '0')}`);
    }
  }

  return [...variants].filter(Boolean);
}

async function findOrderViaWalkInToken(restaurantId, variants) {
   // Step 1: Find walk_in_token — id IS the token (e.g. 'T-2606-132')
  const { data: witRows } = await supabaseAdmin
    .from('walk_in_tokens')
    .select('id, phone')
    .eq('restaurant_id', restaurantId)
    .in('id', variants)
    .order('arrived_at', { ascending: false })
    .limit(1);

  const wit = witRows?.[0];
  if (!wit?.id || !wit.phone) return null;

  // Step 2: Find most recent order by phone (within 6 hrs to avoid stale matches)
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('customer_phone', wit.phone)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);

  return orders?.[0]?.id || null;
  
   // Fallback: check orders table directly
  const { data: directOrder } = await supabaseAdmin
    .from('orders')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('walk_in_token_id', wit.id)   // ← adjust FK name if different
    .order('created_at', { ascending: false })
    .limit(1);

  return directOrder?.[0]?.id || null;
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

    console.log('[findOrderViaBooking]', { restaurantId, variants, bookings }); // ← ADD THIS

  const booking = bookings?.[0];
  if (!booking?.id) return null;

  const { data: orderItems } = await supabaseAdmin
    .from('order_items')
    .select('order_id')
    .eq('booking_id', booking.id)
    .order('created_at', { ascending: false })
    .limit(1);

    console.log('[findOrderViaBooking] orderItems for booking', booking.id, orderItems); // ← ADD THIS
  
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

  const byWalkIn = await findOrderViaWalkInToken(restaurantId, variants);  // ← ADD
  if (byWalkIn) return { order_id: byWalkIn };

  const byKds = await findOrderViaKdsToken(restaurantId, variants);
  if (byKds) return { order_id: byKds };

  console.warn('[takeawayScanResolve] Unresolved QR scan', {
    restaurantId,
    raw,
    parsed,
    variants,
    suffixes,
  });

  console.error('[takeawayScanResolve] Full debug', {
  restaurantId,
  raw,
  parsed,
  variants: variants.slice(0, 10), // first 10 for brevity
  suffixes,
});

  return {
    error: 'No order found for this QR. Ask the customer to show the receipt QR from WhatsApp.',
  };
  
}

module.exports = {
  parseQrScanInput,
  buildTokenVariants,
  resolveOrderIdForTakeawayScan,
};
