'use strict';

/**
 * Allocate ORD-B2B-{YYYYMMDD}-{seq} from existing order_number values.
 *
 * supply_orders.order_number is globally unique; seq is derived from the max
 * trailing number for the delivery-date prefix (not created_at day counts).
 */

const PREFIX = 'ORD-B2B-';

function orderNumberPrefix(deliveryDate) {
  const dateStr = String(deliveryDate || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(dateStr)) {
    throw new Error(`Invalid delivery date for order number: ${deliveryDate}`);
  }
  return `${PREFIX}${dateStr}-`;
}

function parseSeq(orderNumber, prefix) {
  if (!orderNumber || !String(orderNumber).startsWith(prefix)) return 0;
  const tail = String(orderNumber).slice(prefix.length);
  const n = parseInt(tail, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} _supplierId  unused — kept for call-site clarity; uniqueness is global
 * @param {string} deliveryDate YYYY-MM-DD
 * @returns {Promise<string>}
 */
async function nextSupplyOrderNumber(supabase, _supplierId, deliveryDate) {
  const prefix = orderNumberPrefix(deliveryDate);

  // Global scan: constraint is on order_number alone (no supplier in the format).
  const { data, error } = await supabase
    .from('supply_orders')
    .select('order_number')
    .like('order_number', `${prefix}%`);

  if (error) throw error;

  let maxSeq = 0;
  for (const row of data || []) {
    maxSeq = Math.max(maxSeq, parseSeq(row.order_number, prefix));
  }

  const seq = String(maxSeq + 1).padStart(3, '0');
  return `${prefix}${seq}`;
}

function isOrderNumberUniqueViolation(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  const msg = String(err.message || err.details || '');
  return /supply_orders_order_number_unique|duplicate key.*order_number/i.test(msg);
}

module.exports = {
  nextSupplyOrderNumber,
  isOrderNumberUniqueViolation,
  orderNumberPrefix,
};
