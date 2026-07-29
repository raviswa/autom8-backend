'use strict';

/**
 * Durable owner-dashboard / accounting source of truth.
 *
 * Invoices are short-lived (~3 day retention for receipt / Zoho push) and MUST NOT
 * drive KPIs or the paid-collections list. Use paid bookings + completed POS orders.
 */

function isPaidStatus(status) {
  const ps = String(status || '').toLowerCase();
  return ps === 'paid' || ps === 'captured' || ps === 'success';
}

function cartSum(cart) {
  if (!cart || typeof cart !== 'object') return 0;
  const lines = Array.isArray(cart) ? cart : Object.values(cart);
  return lines.reduce((sum, line) => {
    if (!line || typeof line !== 'object') return sum;
    const qty = Number(line.qty ?? line.quantity ?? 1) || 1;
    const price = Number(line.unit_price ?? line.price ?? 0) || 0;
    return sum + qty * price;
  }, 0);
}

/**
 * Resolve a durable paid amount from a booking row.
 * Prefer persisted schedule_meta.total (written at pay time).
 */
function resolveBookingAmount(booking) {
  const meta = booking?.schedule_meta || {};
  const bmeta = booking?.meta || {};
  const web = bmeta.web_cart_submission || meta.web_cart_submission || {};
  const prepay = bmeta.prepay_fulfillment_payload || meta.prepay_fulfillment_payload || {};

  const candidates = [
    meta.total,
    meta.totals?.total,
    meta.totals?.grand_total,
    meta.payable_total,
    web.total,
    web.grand_total,
    web.amount_paid,
    web.razorpay_amount,
    bmeta.total,
    bmeta.grand_total,
    bmeta.amount_paid,
    bmeta.razorpay_amount,
    prepay.total,
    prepay.totals?.grand_total,
    prepay.order_total,
    booking.order_subtotal,
  ];

  for (const raw of candidates) {
    const n = Number(raw);
    if (n > 0) return Math.round(n * 100) / 100;
  }

  const fromCart = cartSum(meta.cart) || cartSum(bmeta.cart) || cartSum(prepay.cart);
  if (fromCart > 0) return Math.round(fromCart * 100) / 100;
  return 0;
}

/** Alias for manager reports — same durable resolver. */
function bookingRevenueTotal(booking) {
  return resolveBookingAmount(booking);
}

/**
 * Merge a durable total into schedule_meta so reports survive payload clear.
 * Returns the next schedule_meta object (does not write to DB).
 */
function withPersistedBookingTotal(scheduleMeta, amount) {
  const n = Number(amount);
  if (!(n > 0)) return scheduleMeta || {};
  const meta = { ...(scheduleMeta && typeof scheduleMeta === 'object' ? scheduleMeta : {}) };
  meta.total = n;
  meta.totals = { ...(meta.totals && typeof meta.totals === 'object' ? meta.totals : {}), total: n, grand_total: n };
  return meta;
}

function linkedOrderIdFromBooking(booking) {
  const meta = booking?.schedule_meta || {};
  const bmeta = booking?.meta || {};
  return (
    meta.order_id
    || bmeta.order_id
    || meta.orderId
    || bmeta.fulfilled_order_id
    || null
  );
}

function normalizePaidBookingRow(booking, amount) {
  const customer = booking.customer || booking.customers || {};
  return {
    id: booking.id,
    booking_id: booking.id,
    order_id: linkedOrderIdFromBooking(booking),
    created_at: booking.created_at || booking.updated_at,
    service_type: booking.service_type || null,
    status: 'paid',
    payment_status: booking.payment_status || 'paid',
    party_size: booking.party_size ?? null,
    token_number: booking.token_number || null,
    token_id: booking.token_number || null,
    total_amount: amount,
    source: 'booking',
    customers: {
      name: customer.name || booking.customer_name || null,
      phone: customer.phone || booking.customer_phone || null,
    },
    customer_name: customer.name || booking.customer_name || null,
    customer_phone: customer.phone || booking.customer_phone || null,
  };
}

function normalizePaidOrderRow(order, amount) {
  return {
    id: order.id,
    booking_id: order.booking_id || null,
    order_id: order.id,
    created_at: order.created_at,
    service_type: order.service_type || order.source || null,
    status: 'completed',
    payment_status: order.payment_status || 'paid',
    party_size: order.party_size ?? null,
    token_number: order.token_number || order.token_id || null,
    token_id: order.token_id || null,
    total_amount: amount,
    source: 'order',
    customers: {
      name: order.customer_name || null,
      phone: order.customer_phone || null,
    },
    customer_name: order.customer_name || null,
    customer_phone: order.customer_phone || null,
  };
}

/**
 * @returns {Promise<{ rows: object[], totalRevenue: number, paidCount: number, orderIds: string[], bookingIds: string[], fromLedger: boolean }>}
 */
async function fetchPaidCollections(supabaseAdmin, restaurantId, startISO, endISO) {
  // Prefer durable paid_sales ledger (item+GST frozen at payment success).
  const ledgerRes = await supabaseAdmin
    .from('paid_sales')
    .select(`
      id, booking_id, order_id, created_at, paid_at, service_type, token_number,
      customer_phone, customer_name, grand_total, subtotal, gst_amount,
      cgst_amount, sgst_amount, igst_amount, gst_rate, delivery_charge
    `)
    .eq('restaurant_id', restaurantId)
    .gte('paid_at', startISO)
    .lte('paid_at', endISO)
    .order('paid_at', { ascending: false })
    .limit(1000);

  if (!ledgerRes.error && (ledgerRes.data || []).length > 0) {
    const rows = (ledgerRes.data || [])
      .map((s) => {
        const amount = Number(s.grand_total) || 0;
        if (!(amount > 0)) return null;
        return {
          id: s.id,
          booking_id: s.booking_id || null,
          order_id: s.order_id || null,
          created_at: s.paid_at || s.created_at,
          service_type: s.service_type || null,
          status: 'paid',
          payment_status: 'paid',
          party_size: null,
          token_number: s.token_number || null,
          token_id: s.token_number || null,
          total_amount: amount,
          subtotal: Number(s.subtotal) || 0,
          gst_amount: Number(s.gst_amount) || 0,
          source: 'paid_sales',
          customers: {
            name: s.customer_name || null,
            phone: s.customer_phone || null,
          },
          customer_name: s.customer_name || null,
          customer_phone: s.customer_phone || null,
        };
      })
      .filter(Boolean);

    const totalRevenue = Math.round(
      rows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0) * 100,
    ) / 100;

    return {
      rows,
      totalRevenue,
      paidCount: rows.length,
      invoiceCount: rows.length,
      orderIds: rows.map((r) => r.order_id).filter(Boolean),
      bookingIds: rows.map((r) => r.booking_id).filter(Boolean),
      fromLedger: true,
    };
  }

  if (ledgerRes.error && !/does not exist|relation|Could not find/i.test(ledgerRes.error.message || '')) {
    console.warn('[paidRevenue] paid_sales query failed:', ledgerRes.error.message);
  }

  // Transition fallback: paid bookings + completed POS (pre-ledger rows).
  return fetchPaidCollectionsLegacy(supabaseAdmin, restaurantId, startISO, endISO);
}

async function fetchPaidCollectionsLegacy(supabaseAdmin, restaurantId, startISO, endISO) {
  const [bookingsRes, ordersRes] = await Promise.all([
    supabaseAdmin
      .from('bookings')
      .select(`
        id, created_at, updated_at, status, payment_status, service_type,
        token_number, party_size, schedule_meta, meta, order_subtotal,
        customer_name, customer_phone,
        customer:customer_id(name, phone)
      `)
      .eq('restaurant_id', restaurantId)
      .in('payment_status', ['paid', 'captured', 'success'])
      .neq('status', 'cancelled')
      .gte('created_at', startISO)
      .lte('created_at', endISO)
      .order('created_at', { ascending: false })
      .limit(1000),
    supabaseAdmin
      .from('orders')
      .select('id, created_at, status, payment_status, source, service_type, total_amount, customer_phone, customer_name, token_id, booking_id')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'completed')
      .gte('created_at', startISO)
      .lte('created_at', endISO)
      .order('created_at', { ascending: false })
      .limit(1000),
  ]);

  let bookings = [];
  if (bookingsRes.error) {
    console.warn('[paidRevenue] bookings query failed, retrying lean select:', bookingsRes.error.message);
    const lean = await supabaseAdmin
      .from('bookings')
      .select('id, created_at, status, payment_status, service_type, token_number, schedule_meta, meta')
      .eq('restaurant_id', restaurantId)
      .in('payment_status', ['paid', 'captured', 'success'])
      .neq('status', 'cancelled')
      .gte('created_at', startISO)
      .lte('created_at', endISO)
      .order('created_at', { ascending: false })
      .limit(1000);
    if (lean.error) throw lean.error;
    bookings = lean.data || [];
  } else {
    bookings = bookingsRes.data || [];
  }

  let orders = [];
  if (ordersRes.error) {
    console.warn('[paidRevenue] orders query failed:', ordersRes.error.message);
    const leanOrders = await supabaseAdmin
      .from('orders')
      .select('id, created_at, status, payment_status, source, total_amount, customer_phone, customer_name, token_id')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'completed')
      .gte('created_at', startISO)
      .lte('created_at', endISO)
      .limit(1000);
    if (leanOrders.error) {
      console.warn('[paidRevenue] orders lean query failed:', leanOrders.error.message);
      orders = [];
    } else {
      orders = (leanOrders.data || []).map((o) => ({ ...o, service_type: null, booking_id: null }));
    }
  } else {
    orders = ordersRes.data || [];
  }

  const rows = [];
  const countedOrderIds = new Set();
  const bookingIds = [];

  for (const b of bookings) {
    const amount = resolveBookingAmount(b);
    if (!(amount > 0)) continue;
    const row = normalizePaidBookingRow(b, amount);
    rows.push(row);
    bookingIds.push(b.id);
    if (row.order_id) countedOrderIds.add(String(row.order_id));
  }

  const zeroOrderIds = orders
    .filter((o) => !(Number(o.total_amount) > 0))
    .map((o) => o.id)
    .filter(Boolean);
  let itemRevenueById = {};
  if (zeroOrderIds.length) {
    const { data: items } = await supabaseAdmin
      .from('order_items')
      .select('order_id, quantity, unit_price, menu_item:menu_item_id(price)')
      .in('order_id', zeroOrderIds);
    for (const it of items || []) {
      const qty = Number(it.quantity) || 1;
      const price = Number(it.unit_price ?? it.menu_item?.price) || 0;
      itemRevenueById[it.order_id] = (itemRevenueById[it.order_id] || 0) + qty * price;
    }
  }

  for (const o of orders) {
    if (countedOrderIds.has(String(o.id))) continue;
    if (o.booking_id && bookingIds.includes(o.booking_id)) continue;

    let amount = Number(o.total_amount) || 0;
    if (!(amount > 0)) amount = Number(itemRevenueById[o.id]) || 0;
    if (!(amount > 0)) continue;

    if (o.payment_status && !isPaidStatus(o.payment_status) && String(o.payment_status).toLowerCase() !== 'na') {
      continue;
    }

    rows.push(normalizePaidOrderRow(o, Math.round(amount * 100) / 100));
    countedOrderIds.add(String(o.id));
  }

  rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  const totalRevenue = Math.round(
    rows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0) * 100,
  ) / 100;

  return {
    rows,
    totalRevenue,
    paidCount: rows.length,
    invoiceCount: rows.length,
    orderIds: rows.map((r) => r.order_id).filter(Boolean),
    bookingIds,
    fromLedger: false,
  };
}

async function fetchPaidSaleItems(supabaseAdmin, restaurantId, startISO, endISO) {
  const { data, error } = await supabaseAdmin
    .from('paid_sale_items')
    .select('item_name, quantity, unit_price, line_total, menu_item_id, paid_at')
    .eq('restaurant_id', restaurantId)
    .gte('paid_at', startISO)
    .lte('paid_at', endISO)
    .limit(5000);
  if (error) {
    console.warn('[paidRevenue] paid_sale_items query failed:', error.message);
    return [];
  }
  return data || [];
}

function buildPaidPeriodSummary(paid, tokens) {
  const totalRevenue = Number(paid?.totalRevenue) || 0;
  const totalOrders = Number(paid?.paidCount ?? paid?.invoiceCount) || 0;
  const tokenRows = tokens ?? [];
  const seated = tokenRows.filter((t) => t.seated_at && t.arrived_at);
  const avgWait = seated.length
    ? Math.round(seated.reduce((s, t) => s + (new Date(t.seated_at) - new Date(t.arrived_at)) / 60000, 0) / seated.length)
    : null;
  const completed = tokenRows.filter((t) => t.seated_at && t.completed_at);
  const avgDining = completed.length
    ? Math.round(completed.reduce((s, t) => s + (new Date(t.completed_at) - new Date(t.seated_at)) / 60000, 0) / completed.length)
    : null;

  const paidTokenKeys = new Set(
    (paid?.rows || [])
      .flatMap((r) => [r.token_id, r.token_number])
      .filter(Boolean)
      .map(String),
  );
  const incompleteTokens = tokenRows.filter((t) => !paidTokenKeys.has(String(t.id))).length;

  return {
    totalRevenue,
    totalOrders,
    aov: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0,
    totalCovers: totalOrders,
    tokensIssued: tokenRows.length,
    incompleteTokens,
    paidCount: totalOrders,
    invoicedCount: totalOrders, // legacy alias for frontend that still reads this key
    avgDining,
    avgWait,
  };
}

module.exports = {
  isPaidStatus,
  resolveBookingAmount,
  bookingRevenueTotal,
  withPersistedBookingTotal,
  fetchPaidCollections,
  fetchPaidSaleItems,
  buildPaidPeriodSummary,
  // Temporary aliases while callers migrate off invoice naming
  fetchInvoicedOrders: fetchPaidCollections,
  buildInvoicedPeriodSummary: buildPaidPeriodSummary,
};
