'use strict';

/**
 * Sequential per-tenant invoice numbering (Indian financial year: Apr 1 - Mar 31).
 * GST law expects a continuous, unique invoice series — the order_number is
 * not guaranteed to be sequential/gap-free, so it should not double as the
 * invoice identifier on tax invoices.
 */

function financialYearLabel(date = new Date()) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-indexed; 3 = April
  const startYear = month >= 3 ? year : year - 1;
  const endYearShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endYearShort}`;
}

/**
 * Best-effort atomic-ish increment: read then upsert. Under rare concurrent
 * generation for the same tenant this could in theory hand out a duplicate,
 * but invoice generation is a low-concurrency, per-order, admin-triggered
 * action in this app, so a read-then-write counter is an acceptable
 * trade-off versus adding a dedicated Postgres sequence/RPC.
 */
async function nextInvoiceSequence(supabaseAdmin, restaurantId, financialYear) {
  const { data: existing, error: readErr } = await supabaseAdmin
    .from('invoice_counters')
    .select('last_number')
    .eq('restaurant_id', restaurantId)
    .eq('financial_year', financialYear)
    .maybeSingle();
  if (readErr) throw readErr;

  const next = (existing?.last_number || 0) + 1;
  const { error: writeErr } = await supabaseAdmin
    .from('invoice_counters')
    .upsert(
      { restaurant_id: restaurantId, financial_year: financialYear, last_number: next, updated_at: new Date().toISOString() },
      { onConflict: 'restaurant_id,financial_year' },
    );
  if (writeErr) throw writeErr;
  return next;
}

/**
 * Returns the existing invoice_number for this order if one was already
 * minted, otherwise mints and returns a new one. Never regenerates a number
 * for an order that already has one (re-generating a PDF must not burn a
 * new sequence number).
 */
async function ensureInvoiceNumber(supabaseAdmin, restaurantId, orderId, invoiceDate = new Date()) {
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from('invoices')
    .select('invoice_number')
    .eq('order_id', orderId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle();
  if (existingErr) throw existingErr;
  if (existing?.invoice_number) return existing.invoice_number;

  const fy = financialYearLabel(invoiceDate);
  const seq = await nextInvoiceSequence(supabaseAdmin, restaurantId, fy);
  return `INV/${fy}/${String(seq).padStart(6, '0')}`;
}

module.exports = { financialYearLabel, nextInvoiceSequence, ensureInvoiceNumber };
