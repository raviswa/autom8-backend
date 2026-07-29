'use strict';

/**
 * Durable paid-sale ledger writer.
 * Invoices are ephemeral (~3d); this ledger is the owner-dashboard / item-spend SoT.
 */

const { isInterState, resolveOrderPincode } = require('./pincodeState');

const DEFAULT_GST_RATE = 5;

function calculateGST(subtotal, ratePercent = DEFAULT_GST_RATE) {
  const rate = Number(ratePercent) || DEFAULT_GST_RATE;
  const halfRate = rate / 2;
  const cgst = parseFloat(((subtotal * halfRate) / 100).toFixed(2));
  const sgst = parseFloat(((subtotal * halfRate) / 100).toFixed(2));
  const totalTax = parseFloat((cgst + sgst).toFixed(2));
  const grandTotalUnrounded = parseFloat((subtotal + totalTax).toFixed(2));
  const grandTotal = Math.round(grandTotalUnrounded);
  const roundOff = parseFloat((grandTotal - grandTotalUnrounded).toFixed(2));
  return { cgst, sgst, totalTax, grandTotal, roundOff, grandTotalUnrounded };
}

function buildLinesFromCart(cart) {
  if (!cart || typeof cart !== 'object') return [];
  const entries = Array.isArray(cart) ? cart.map((line, i) => [String(i), line]) : Object.entries(cart);
  const lines = [];
  for (const [sku, line] of entries) {
    if (!line || typeof line !== 'object') continue;
    const qty = Number(line.qty ?? line.quantity ?? 1) || 1;
    const unitPrice = Number(line.unit_price ?? line.price ?? 0) || 0;
    const name = String(line.title || line.name || line.item_name || sku || 'Item').trim() || 'Item';
    lines.push({
      menu_item_id: line.menu_item_id || null,
      item_name: name,
      item_sku: String(line.retailer_id || sku || ''),
      quantity: qty,
      unit_price: unitPrice,
      line_total: Math.round(qty * unitPrice * 100) / 100,
    });
  }
  return lines.filter((l) => l.quantity > 0);
}

function buildLinesFromOrderItems(orderItems) {
  return (orderItems || []).map((oi) => {
    const qty = Number(oi.quantity ?? 1) || 1;
    const unitPrice = Number(oi.unit_price ?? oi.menu_item?.price ?? 0) || 0;
    return {
      menu_item_id: oi.menu_item_id || oi.menu_item?.id || null,
      item_name: oi.menu_item?.name || oi.item_name || oi.name || 'Item',
      item_sku: oi.retailer_id || null,
      quantity: qty,
      unit_price: unitPrice,
      line_total: Math.round(qty * unitPrice * 100) / 100,
    };
  }).filter((l) => l.quantity > 0);
}

function computeGstBreakdown({
  subtotal,
  deliveryCharge = 0,
  gstRate = DEFAULT_GST_RATE,
  restaurant = null,
  buyerPincode = null,
}) {
  const base = Math.max(0, Number(subtotal) || 0);
  const delivery = Math.max(0, Number(deliveryCharge) || 0);
  const rate = Number(gstRate) || DEFAULT_GST_RATE;
  const { cgst, sgst, totalTax, grandTotal } = calculateGST(base, rate);

  let cgstAmount = cgst;
  let sgstAmount = sgst;
  let igstAmount = 0;
  let gstAmount = totalTax;

  const sellerState = restaurant?.state || null;
  const pin = buyerPincode || resolveOrderPincode({ customer_pincode: restaurant?.buyer_pincode });
  const inter = isInterState(sellerState, pin);
  if (inter === true) {
    igstAmount = parseFloat((cgst + sgst).toFixed(2));
    cgstAmount = 0;
    sgstAmount = 0;
    gstAmount = igstAmount;
  }

  const finalTotal = parseFloat((grandTotal + delivery).toFixed(2));
  return {
    gst_rate: rate,
    cgst_amount: cgstAmount,
    sgst_amount: sgstAmount,
    igst_amount: igstAmount,
    gst_amount: gstAmount,
    delivery_charge: delivery,
    grand_total: finalTotal,
  };
}

function sumLines(lines) {
  return Math.round((lines || []).reduce((s, l) => s + (Number(l.line_total) || 0), 0) * 100) / 100;
}

/**
 * Idempotent insert of paid_sales + paid_sale_items.
 * @returns {{ ok: boolean, sale?: object, skipped?: boolean, error?: string }}
 */
async function recordPaidSale(supabaseAdmin, payload) {
  const {
    restaurantId,
    lobType = null,
    bookingId = null,
    orderId = null,
    customerPhone = null,
    customerName = null,
    serviceType = null,
    tokenNumber = null,
    lines = [],
    subtotal: subtotalIn = null,
    deliveryCharge = 0,
    gstRate = DEFAULT_GST_RATE,
    restaurant = null,
    buyerPincode = null,
    paidAt = null,
  } = payload || {};

  if (!restaurantId) return { ok: false, error: 'restaurantId required' };
  if (!bookingId && !orderId) return { ok: false, error: 'bookingId or orderId required' };

  // Already recorded?
  if (bookingId) {
    const { data: existing } = await supabaseAdmin
      .from('paid_sales')
      .select('id')
      .eq('booking_id', bookingId)
      .maybeSingle();
    if (existing?.id) return { ok: true, skipped: true, sale: existing };
  }
  if (orderId) {
    const { data: existing } = await supabaseAdmin
      .from('paid_sales')
      .select('id')
      .eq('order_id', orderId)
      .maybeSingle();
    if (existing?.id) return { ok: true, skipped: true, sale: existing };
  }

  const safeLines = (lines || []).filter((l) => (Number(l.quantity) || 0) > 0);
  let subtotal = subtotalIn != null ? Number(subtotalIn) : sumLines(safeLines);
  if (!(subtotal > 0) && safeLines.length) subtotal = sumLines(safeLines);
  if (!(subtotal > 0)) {
    return { ok: false, error: 'subtotal/lines required' };
  }

  const gst = computeGstBreakdown({
    subtotal,
    deliveryCharge,
    gstRate,
    restaurant,
    buyerPincode,
  });

  const paid_at = paidAt || new Date().toISOString();
  const header = {
    restaurant_id: restaurantId,
    lob_type: lobType,
    booking_id: bookingId,
    order_id: orderId,
    customer_phone: customerPhone,
    customer_name: customerName,
    service_type: serviceType,
    token_number: tokenNumber != null ? String(tokenNumber) : null,
    subtotal,
    ...gst,
    currency: 'INR',
    paid_at,
  };

  const { data: sale, error: saleErr } = await supabaseAdmin
    .from('paid_sales')
    .insert(header)
    .select('*')
    .single();

  if (saleErr) {
    // Unique race → treat as success
    if (/duplicate|unique/i.test(saleErr.message || '')) {
      return { ok: true, skipped: true, error: saleErr.message };
    }
    return { ok: false, error: saleErr.message };
  }

  if (safeLines.length) {
    const itemRows = safeLines.map((l) => ({
      paid_sale_id: sale.id,
      restaurant_id: restaurantId,
      menu_item_id: l.menu_item_id || null,
      item_name: l.item_name || 'Item',
      item_sku: l.item_sku || null,
      quantity: Number(l.quantity) || 1,
      unit_price: Number(l.unit_price) || 0,
      line_total: Number(l.line_total) || 0,
      paid_at,
    }));
    const { error: itemsErr } = await supabaseAdmin.from('paid_sale_items').insert(itemRows);
    if (itemsErr) {
      console.warn('[paidSaleLedger] items insert failed:', itemsErr.message);
    }
  }

  return { ok: true, sale };
}

async function recordPaidSaleFromBooking(supabaseAdmin, booking, { restaurant = null } = {}) {
  if (!booking?.id || !booking.restaurant_id) return { ok: false, error: 'booking required' };

  const meta = booking.schedule_meta || {};
  const bmeta = booking.meta || {};
  const cart = meta.cart
    || bmeta.cart
    || bmeta.prepay_fulfillment_payload?.cart
    || bmeta.prepay_fulfillment_payload?.cart_snapshot
    || meta.prepay_fulfillment_payload?.cart
    || {};
  const lines = buildLinesFromCart(cart);
  const customer = booking.customer || {};
  const delivery = Number(
    meta.delivery_charge
    ?? bmeta.delivery_charge
    ?? bmeta.web_cart_submission?.delivery_charge
    ?? 0,
  ) || 0;

  let subtotal = Number(meta.total ?? meta.totals?.total ?? meta.totals?.grand_total ?? booking.order_subtotal ?? 0);
  if (!(subtotal > 0)) subtotal = sumLines(lines);
  // If grand already includes tax, prefer line sum as pre-GST base when available.
  if (lines.length && sumLines(lines) > 0) {
    subtotal = sumLines(lines);
  }

  return recordPaidSale(supabaseAdmin, {
    restaurantId: booking.restaurant_id,
    lobType: restaurant?.lob_type || booking.lob_type || null,
    bookingId: booking.id,
    orderId: meta.order_id || bmeta.order_id || null,
    customerPhone: customer.phone || booking.customer_phone || null,
    customerName: customer.name || booking.customer_name || null,
    serviceType: booking.service_type || null,
    tokenNumber: booking.token_number || null,
    lines,
    subtotal,
    deliveryCharge: delivery,
    restaurant,
    paidAt: booking.updated_at || booking.created_at || null,
  });
}

async function recordPaidSaleFromOrder(supabaseAdmin, order, { restaurant = null, orderItems = null } = {}) {
  if (!order?.id || !order.restaurant_id) return { ok: false, error: 'order required' };

  let items = orderItems;
  if (!items) {
    const { data } = await supabaseAdmin
      .from('order_items')
      .select('quantity, unit_price, menu_item_id, menu_item:menu_item_id(id, name, price)')
      .eq('order_id', order.id);
    items = data || [];
  }
  const lines = buildLinesFromOrderItems(items);
  let subtotal = Number(order.subtotal) || sumLines(lines);
  if (!(subtotal > 0)) subtotal = Number(order.total_amount) || 0;

  return recordPaidSale(supabaseAdmin, {
    restaurantId: order.restaurant_id,
    lobType: restaurant?.lob_type || null,
    bookingId: order.booking_id || null,
    orderId: order.id,
    customerPhone: order.customer_phone || null,
    customerName: order.customer_name || null,
    serviceType: order.service_type || order.source || null,
    tokenNumber: order.token_number || order.token_id || null,
    lines,
    subtotal,
    deliveryCharge: Number(order.delivery_charge) || 0,
    restaurant,
    paidAt: order.updated_at || order.created_at || null,
  });
}

module.exports = {
  DEFAULT_GST_RATE,
  calculateGST,
  buildLinesFromCart,
  buildLinesFromOrderItems,
  computeGstBreakdown,
  sumLines,
  recordPaidSale,
  recordPaidSaleFromBooking,
  recordPaidSaleFromOrder,
};
