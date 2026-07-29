'use strict';

/**
 * Backfill paid_sales / paid_sale_items from historical paid bookings + completed orders.
 * Used by POST /api/dashboard/paid-sales/backfill
 */

const {
  recordPaidSaleFromBooking,
  recordPaidSaleFromOrder,
} = require('./paidSaleLedger');

async function backfillPaidSales(supabaseAdmin, restaurantId, { startISO, endISO, limit = 500 } = {}) {
  const result = {
    bookingsAttempted: 0,
    bookingsWritten: 0,
    bookingsSkipped: 0,
    ordersAttempted: 0,
    ordersWritten: 0,
    ordersSkipped: 0,
    errors: [],
  };

  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('id, lob_type, state, postal_code')
    .eq('id', restaurantId)
    .maybeSingle();

  let bookingQuery = supabaseAdmin
    .from('bookings')
    .select(`
      id, restaurant_id, created_at, updated_at, status, payment_status, service_type,
      token_number, schedule_meta, meta, order_subtotal, customer_name, customer_phone,
      customer:customer_id(name, phone)
    `)
    .eq('restaurant_id', restaurantId)
    .in('payment_status', ['paid', 'captured', 'success'])
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (startISO) bookingQuery = bookingQuery.gte('created_at', startISO);
  if (endISO) bookingQuery = bookingQuery.lte('created_at', endISO);

  const { data: bookings, error: bErr } = await bookingQuery;
  if (bErr) {
    result.errors.push(`bookings: ${bErr.message}`);
  } else {
    for (const b of bookings || []) {
      result.bookingsAttempted += 1;
      try {
        const r = await recordPaidSaleFromBooking(supabaseAdmin, b, { restaurant: tenant });
        if (r.skipped) result.bookingsSkipped += 1;
        else if (r.ok) result.bookingsWritten += 1;
        else result.errors.push(`booking ${b.id}: ${r.error}`);
      } catch (e) {
        result.errors.push(`booking ${b.id}: ${e.message}`);
      }
    }
  }

  let orderQuery = supabaseAdmin
    .from('orders')
    .select('id, restaurant_id, created_at, updated_at, status, payment_status, source, service_type, total_amount, subtotal, delivery_charge, customer_phone, customer_name, token_id, booking_id')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (startISO) orderQuery = orderQuery.gte('created_at', startISO);
  if (endISO) orderQuery = orderQuery.lte('created_at', endISO);

  const { data: orders, error: oErr } = await orderQuery;
  if (oErr) {
    result.errors.push(`orders: ${oErr.message}`);
  } else {
    for (const o of orders || []) {
      // Skip if linked booking already covered
      if (o.booking_id) {
        const { data: existing } = await supabaseAdmin
          .from('paid_sales')
          .select('id')
          .eq('booking_id', o.booking_id)
          .maybeSingle();
        if (existing?.id) {
          result.ordersSkipped += 1;
          continue;
        }
      }
      result.ordersAttempted += 1;
      try {
        const r = await recordPaidSaleFromOrder(supabaseAdmin, o, { restaurant: tenant });
        if (r.skipped) result.ordersSkipped += 1;
        else if (r.ok) result.ordersWritten += 1;
        else result.errors.push(`order ${o.id}: ${r.error}`);
      } catch (e) {
        result.errors.push(`order ${o.id}: ${e.message}`);
      }
    }
  }

  return result;
}

module.exports = { backfillPaidSales };
