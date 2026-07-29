'use strict';

/**
 * Owner-dashboard / accounting source of truth: invoices only.
 * Amount = invoices.grand_total (fallback: payload.financial_breakdown.grand_total).
 */

function invoiceAmount(invoice) {
  const fromCol = Number(invoice?.grand_total);
  if (fromCol > 0) return Math.round(fromCol * 100) / 100;
  const fromPayload = Number(
    invoice?.payload?.financial_breakdown?.grand_total
    ?? invoice?.payload?.financial_breakdown?.grandTotal
    ?? 0,
  );
  if (fromPayload > 0) return Math.round(fromPayload * 100) / 100;
  return 0;
}

function invoiceAt(invoice) {
  return (
    invoice?.generated_at
    || invoice?.payload?.invoice_meta?.invoice_date
    || invoice?.created_at
    || null
  );
}

/**
 * @returns {Promise<{ rows: object[], totalRevenue: number, invoiceCount: number, orderIds: string[] }>}
 */
async function fetchInvoicedOrders(supabaseAdmin, restaurantId, startISO, endISO) {
  const { data, error } = await supabaseAdmin
    .from('invoices')
    .select(`
      id,
      order_id,
      invoice_number,
      grand_total,
      generated_at,
      payload,
      orders:order_id (
        id,
        created_at,
        status,
        source,
        service_type,
        total_amount,
        customer_phone,
        customer_name,
        token_id
      )
    `)
    .eq('restaurant_id', restaurantId)
    .gte('generated_at', startISO)
    .lte('generated_at', endISO)
    .order('generated_at', { ascending: false })
    .limit(1000);

  if (error) {
    // Older schemas may lack generated_at range support or FK embed — fall back.
    console.warn('[invoicedRevenue] primary invoice query failed:', error.message);
    const fallback = await supabaseAdmin
      .from('invoices')
      .select('id, order_id, invoice_number, grand_total, generated_at, payload, created_at')
      .eq('restaurant_id', restaurantId)
      .order('generated_at', { ascending: false })
      .limit(1000);

    if (fallback.error) throw fallback.error;

    const startMs = new Date(startISO).getTime();
    const endMs = new Date(endISO).getTime();
    const invoices = (fallback.data || []).filter((inv) => {
      const ts = new Date(invoiceAt(inv) || 0).getTime();
      return Number.isFinite(ts) && ts >= startMs && ts <= endMs;
    });

    const orderIds = invoices.map((i) => i.order_id).filter(Boolean);
    let ordersById = {};
    if (orderIds.length) {
      const { data: orders, error: ordersErr } = await supabaseAdmin
        .from('orders')
        .select('id, created_at, status, source, service_type, total_amount, customer_phone, customer_name, token_id')
        .in('id', orderIds);
      if (ordersErr) {
        console.warn('[invoicedRevenue] orders hydrate failed:', ordersErr.message);
      } else {
        ordersById = Object.fromEntries((orders || []).map((o) => [o.id, o]));
      }
    }

    const rows = invoices
      .map((inv) => normalizeInvoiceRow(inv, ordersById[inv.order_id] || null))
      .filter((r) => r.total_amount > 0);

    return summarize(rows);
  }

  const rows = (data || [])
    .map((inv) => normalizeInvoiceRow(inv, inv.orders || null))
    .filter((r) => r.total_amount > 0);

  return summarize(rows);
}

function normalizeInvoiceRow(invoice, order) {
  const amount = invoiceAmount(invoice);
  const createdAt = invoiceAt(invoice) || order?.created_at || null;
  const serviceType = order?.service_type || order?.source
    || invoice?.payload?.invoice_meta?.fulfillment_type
    || null;

  return {
    id: invoice.id,
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number || invoice?.payload?.invoice_meta?.invoice_number || null,
    order_id: invoice.order_id || order?.id || null,
    created_at: createdAt,
    service_type: serviceType,
    status: 'invoiced',
    payment_status: 'paid',
    party_size: null,
    token_number: order?.token_id || null,
    token_id: order?.token_id || null,
    total_amount: amount,
    source: 'invoice',
    customers: {
      name: order?.customer_name || null,
      phone: order?.customer_phone || null,
    },
    customer_name: order?.customer_name || null,
    customer_phone: order?.customer_phone || null,
    // Shape used by insights customer/spend builders
    order_status: order?.status || null,
  };
}

function summarize(rows) {
  const totalRevenue = Math.round(
    rows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0) * 100,
  ) / 100;
  return {
    rows,
    totalRevenue,
    invoiceCount: rows.length,
    orderIds: rows.map((r) => r.order_id).filter(Boolean),
  };
}

function buildInvoicedPeriodSummary(invoiced, tokens) {
  const totalRevenue = Number(invoiced?.totalRevenue) || 0;
  const totalOrders = Number(invoiced?.invoiceCount) || 0;
  const tokenRows = tokens ?? [];
  const seated = tokenRows.filter((t) => t.seated_at && t.arrived_at);
  const avgWait = seated.length
    ? Math.round(seated.reduce((s, t) => s + (new Date(t.seated_at) - new Date(t.arrived_at)) / 60000, 0) / seated.length)
    : null;
  const completed = tokenRows.filter((t) => t.seated_at && t.completed_at);
  const avgDining = completed.length
    ? Math.round(completed.reduce((s, t) => s + (new Date(t.completed_at) - new Date(t.seated_at)) / 60000, 0) / completed.length)
    : null;

  const invoicedTokenIds = new Set(
    (invoiced?.rows || []).map((r) => r.token_id).filter(Boolean),
  );
  const incompleteTokens = tokenRows.filter((t) => !invoicedTokenIds.has(t.id)).length;

  return {
    totalRevenue,
    totalOrders,
    aov: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0,
    totalCovers: totalOrders,
    tokensIssued: tokenRows.length,
    incompleteTokens,
    invoicedCount: totalOrders,
    avgDining,
    avgWait,
  };
}

module.exports = {
  invoiceAmount,
  invoiceAt,
  fetchInvoicedOrders,
  buildInvoicedPeriodSummary,
  normalizeInvoiceRow,
};
