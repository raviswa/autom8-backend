// src/routes/supply/invoices.js
// ============================================================================
// MODULE 9 — Invoice & GST Engine
//
// POST   /api/supply/invoices/generate/:order_id  — triggered on delivery
// GET    /api/supply/invoices                      — list with filters
// GET    /api/supply/invoices/:id                  — single invoice + line items
// GET    /api/supply/invoices/:id/pdf              — download PDF (signed URL)
// POST   /api/supply/invoices/:id/resend           — resend to client WhatsApp
//
// GST logic:
//   - Same state → CGST (rate/2) + SGST (rate/2)
//   - Different state → IGST (full rate)
//   - 0% items go in a separate section (no GST rows)
//
// PDF generation: puppeteer (prefers chromium on Railway)
// Storage: Supabase Storage bucket supply-invoices/{supplier_id}/{invoice_number}.pdf
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const { supabaseAdmin } = require('../../config/supabase');
const { supplyAuthMiddleware: authenticateSupplyToken } = require('../../middleware/supplyAuth');
const { notifyClient } = require('./notify');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the next invoice number for a supplier in the current financial year.
 * Format: INV-YYYYMM-NNN  (e.g. INV-202506-042)
 * Sequence resets each month by default.
 */
async function nextInvoiceNumber(supplierId) {
  const now    = new Date();
  const prefix = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;

  const { count } = await supabaseAdmin
    .from('supply_invoices')
    .select('id', { count: 'exact', head: true })
    .eq('supplier_id', supplierId)
    .like('invoice_number', `${prefix}-%`);

  const seq = String((count || 0) + 1).padStart(3, '0');
  return `${prefix}-${seq}`;
}

/**
 * Calculate GST amounts for a line item.
 * Returns { taxable, cgst, sgst, igst, total } all as floats.
 */
function calcGst(qty, rate, gstRate, isSameState) {
  const taxable = qty * rate;
  if (gstRate === 0) return { taxable, cgst: 0, sgst: 0, igst: 0, total: taxable };

  if (isSameState) {
    const half = (taxable * gstRate) / 200; // rate is %, split in half
    return { taxable, cgst: half, sgst: half, igst: 0, total: taxable + half * 2 };
  } else {
    const igst = (taxable * gstRate) / 100;
    return { taxable, cgst: 0, sgst: 0, igst, total: taxable + igst };
  }
}

/**
 * Build invoice payload from order + delivered items.
 * `deliveredItems` is an array of { item_id, delivered_qty }
 * If deliveredItems is null, uses ordered quantities (full delivery).
 */
async function buildInvoicePayload(supplierId, order, deliveredItems) {
  const { data: supplier } = await supabaseAdmin
    .from('suppliers')
    .select('name, business_name, address, city, state, gstin, email, phone')
    .eq('id', supplierId)
    .single();

  const { data: client } = await supabaseAdmin
    .from('supply_clients')
    .select('name, address, city, pincode, gstin, credit_terms_days, phone')
    // derive state from address/pincode (simplified — store state separately if needed)
    .eq('id', order.client_id)
    .single();

  // Fetch order items with catalog details
  const { data: orderItems } = await supabaseAdmin
    .from('supply_order_items')
    .select(`
      id, item_id, ordered_qty, unit_price,
      supply_catalog_items(name, unit, hsn_code, gst_rate, category)
    `)
    .eq('order_id', order.id);

  // Build delivered qty map
  const deliveredMap = {};
  if (deliveredItems) {
    deliveredItems.forEach(d => { deliveredMap[d.item_id] = parseFloat(d.delivered_qty); });
  }

  const isSameState = (supplier.state || '').toLowerCase() === (client.state || '').toLowerCase();

  let subtotal = 0, totalCgst = 0, totalSgst = 0, totalIgst = 0, grandTotal = 0;

  const lineItems = orderItems
    .map(oi => {
      const qty = deliveredItems
        ? (deliveredMap[oi.item_id] ?? 0)
        : parseFloat(oi.ordered_qty);
      if (qty === 0) return null;

      const gstRate = parseFloat(oi.supply_catalog_items?.gst_rate || 0);
      const rate    = parseFloat(oi.unit_price);
      const gst     = calcGst(qty, rate, gstRate, isSameState);

      subtotal   += gst.taxable;
      totalCgst  += gst.cgst;
      totalSgst  += gst.sgst;
      totalIgst  += gst.igst;
      grandTotal += gst.total;

      return {
        item_id:     oi.item_id,
        name:        oi.supply_catalog_items?.name,
        hsn_code:    oi.supply_catalog_items?.hsn_code || '',
        unit:        oi.supply_catalog_items?.unit,
        qty,
        rate,
        gst_rate:    gstRate,
        ...gst,
      };
    })
    .filter(Boolean);

  return {
    supplier,
    client,
    order_number:  order.order_number,
    delivery_date: order.delivery_date,
    line_items:    lineItems,
    is_same_state: isSameState,
    totals: {
      subtotal:    Math.round(subtotal    * 100) / 100,
      cgst:        Math.round(totalCgst  * 100) / 100,
      sgst:        Math.round(totalSgst  * 100) / 100,
      igst:        Math.round(totalIgst  * 100) / 100,
      grand_total: Math.round(grandTotal * 100) / 100,
    },
    credit_terms_days: client.credit_terms_days || 30,
  };
}

/**
 * Generate invoice HTML (used by puppeteer to produce PDF).
 */
function renderInvoiceHtml(invoiceNumber, invoiceDate, payload) {
  const { supplier, client, order_number, line_items, totals, is_same_state, credit_terms_days } = payload;

  const dueDate = new Date(invoiceDate);
  dueDate.setDate(dueDate.getDate() + credit_terms_days);

  const taxHeaders = is_same_state
    ? '<th>CGST</th><th>SGST</th>'
    : '<th>IGST</th>';

  const lineRows = line_items.map(li => {
    const taxCells = is_same_state
      ? `<td>₹${li.cgst.toFixed(2)}</td><td>₹${li.sgst.toFixed(2)}</td>`
      : `<td>₹${li.igst.toFixed(2)}</td>`;
    return `
      <tr>
        <td>${li.name}</td>
        <td>${li.hsn_code || '—'}</td>
        <td>${li.qty} ${li.unit}</td>
        <td>₹${li.rate.toFixed(2)}</td>
        <td>₹${li.taxable.toFixed(2)}</td>
        <td>${li.gst_rate}%</td>
        ${taxCells}
        <td><strong>₹${li.total.toFixed(2)}</strong></td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 12px; color: #222; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .header { display: flex; justify-content: space-between; margin-bottom: 20px; }
  .header-left h1 { color: #1a56db; }
  .header-right { text-align: right; }
  .parties { display: flex; gap: 40px; margin-bottom: 20px; }
  .party { flex: 1; padding: 12px; border: 1px solid #e5e7eb; border-radius: 6px; }
  .party h3 { margin: 0 0 6px; font-size: 13px; color: #6b7280; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { background: #1a56db; color: #fff; padding: 8px; text-align: left; font-size: 11px; }
  td { padding: 7px 8px; border-bottom: 1px solid #f0f0f0; }
  tr:nth-child(even) td { background: #f9fafb; }
  .totals { float: right; width: 280px; }
  .totals table td { border: none; padding: 4px 8px; }
  .totals .grand td { font-weight: bold; font-size: 14px; border-top: 2px solid #1a56db; padding-top: 8px; }
  .footer { clear: both; margin-top: 20px; font-size: 11px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 12px; }
</style>
</head>
<body>
<div class="header">
  <div class="header-left">
    <h1>${supplier.business_name}</h1>
    <div>${supplier.address}, ${supplier.city}</div>
    <div>GSTIN: ${supplier.gstin || '—'} | Ph: ${supplier.phone}</div>
  </div>
  <div class="header-right">
    <strong>TAX INVOICE</strong><br>
    Invoice No: <strong>${invoiceNumber}</strong><br>
    Invoice Date: ${invoiceDate}<br>
    Order Ref: ${order_number}
  </div>
</div>

<div class="parties">
  <div class="party">
    <h3>Bill To</h3>
    <strong>${client.name}</strong><br>
    ${client.address || ''}, ${client.city || ''} ${client.pincode || ''}<br>
    ${client.gstin ? `GSTIN: ${client.gstin}` : ''}
  </div>
  <div class="party">
    <h3>Payment Terms</h3>
    Net ${credit_terms_days} days<br>
    Due by: ${dueDate.toLocaleDateString('en-IN')}<br>
    Contact: ${client.phone}
  </div>
</div>

<table>
  <thead>
    <tr>
      <th>Item</th><th>HSN</th><th>Qty</th><th>Rate</th><th>Taxable</th><th>GST%</th>
      ${taxHeaders}
      <th>Total</th>
    </tr>
  </thead>
  <tbody>${lineRows}</tbody>
</table>

<div class="totals">
  <table>
    <tr><td>Subtotal (Taxable)</td><td>₹${totals.subtotal.toFixed(2)}</td></tr>
    ${is_same_state
      ? `<tr><td>CGST</td><td>₹${totals.cgst.toFixed(2)}</td></tr>
         <tr><td>SGST</td><td>₹${totals.sgst.toFixed(2)}</td></tr>`
      : `<tr><td>IGST</td><td>₹${totals.igst.toFixed(2)}</td></tr>`
    }
    <tr class="grand"><td>Invoice Total</td><td>₹${totals.grand_total.toFixed(2)}</td></tr>
  </table>
</div>

<div class="footer">
  This is a computer-generated invoice and does not require a physical signature.<br>
  ${supplier.business_name} | ${supplier.email}
</div>
</body>
</html>`;
}

/**
 * Generate PDF from HTML using puppeteer and upload to Supabase Storage.
 * Returns the storage path (permanent) and a 48-hour signed URL.
 */
async function generateAndUploadPdf(invoiceNumber, html, supplierId) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    console.warn('[invoices] puppeteer not installed — PDF generation skipped');
    return { pdf_url: null };
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });

    const storagePath = `${supplierId}/${invoiceNumber}.pdf`;
    const bucket      = process.env.SUPPLY_STORAGE_BUCKET_INVOICES || 'supply-invoices';

    const { error: uploadErr } = await supabaseAdmin.storage
      .from(bucket)
      .upload(storagePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadErr) throw uploadErr;

    const { data: signedData } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrl(storagePath, 172800); // 48 hours

    return { pdf_url: signedData?.signedUrl || null, storage_path: storagePath };
  } finally {
    await browser.close();
  }
}

// ── POST /api/supply/invoices/generate/:order_id ─────────────────────────────
// Called internally when order → delivered or partially_delivered.
// Body: { delivered_items?: [{item_id, delivered_qty}] }
// Returns the new invoice row.
router.post('/generate/:order_id', authenticateSupplyToken, async (req, res) => {
  try {
    const supplierId = req.supplier.id;
    const { order_id } = req.params;
    const { delivered_items } = req.body;

    // Fetch order
    const { data: order } = await supabaseAdmin
      .from('supply_orders')
      .select('*')
      .eq('id', order_id)
      .eq('supplier_id', supplierId)
      .maybeSingle();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Idempotency: don't regenerate if already exists
    const { data: existing } = await supabaseAdmin
      .from('supply_invoices')
      .select('id, invoice_number, pdf_url')
      .eq('order_id', order_id)
      .maybeSingle();
    if (existing) {
      return res.json({ invoice: existing, already_existed: true });
    }

    const invoiceNumber = await nextInvoiceNumber(supplierId);
    const invoiceDate   = new Date().toISOString().slice(0, 10);
    const payload       = await buildInvoicePayload(supplierId, order, delivered_items || null);
    const html          = renderInvoiceHtml(invoiceNumber, invoiceDate, payload);
    const { pdf_url }   = await generateAndUploadPdf(invoiceNumber, html, supplierId);

    const { data: invoice, error: invErr } = await supabaseAdmin
      .from('supply_invoices')
      .insert({
        supplier_id:    supplierId,
        client_id:      order.client_id,
        order_id,
        invoice_number: invoiceNumber,
        invoice_date:   invoiceDate,
        taxable_amount: payload.totals.subtotal,
        cgst_amount:    payload.totals.cgst,
        sgst_amount:    payload.totals.sgst,
        igst_amount:    payload.totals.igst,
        total_amount:   payload.totals.grand_total,
        pdf_url,
      })
      .select()
      .single();
    if (invErr) throw invErr;

    // Send to client via WhatsApp
    const client = payload.client;
    await notifyClient(supplierId, client.phone, 'supply_delivery_done_invoice', {
      order_number:   order.order_number,
      invoice_number: invoiceNumber,
      grand_total:    payload.totals.grand_total,
      pdf_url,
    }, client.id);

    res.status(201).json({ invoice });
  } catch (err) {
    console.error('[invoices] generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/supply/invoices ──────────────────────────────────────────────────
// List invoices with filters.
// Query: client_id, from (date), to (date), page, per_page
router.get('/', authenticateSupplyToken, async (req, res) => {
  try {
    const supplierId = req.supplier.id;
    const { client_id, from, to, page = 1, per_page = 25 } = req.query;
    const limit  = Math.min(parseInt(per_page), 100);
    const offset = (parseInt(page) - 1) * limit;

    let q = supabaseAdmin
      .from('supply_invoices')
      .select(`
        id, invoice_number, invoice_date, total_amount, pdf_url, sent_at, created_at,
        supply_clients(id, name, phone),
        supply_orders(order_number, delivery_date, status)
      `, { count: 'exact' })
      .eq('supplier_id', supplierId)
      .order('invoice_date', { ascending: false })
      .range(offset, offset + limit - 1);

    if (client_id) q = q.eq('client_id', client_id);
    if (from)      q = q.gte('invoice_date', from);
    if (to)        q = q.lte('invoice_date', to);

    const { data: invoices, count, error } = await q;
    if (error) throw error;

    res.json({
      invoices,
      pagination: {
        page: parseInt(page),
        per_page: limit,
        total: count,
        total_pages: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    console.error('[invoices] GET list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/supply/invoices/:id ─────────────────────────────────────────────
router.get('/:id', authenticateSupplyToken, async (req, res) => {
  try {
    const { id }     = req.params;
    const supplierId = req.supplier.id;

    const { data: invoice, error } = await supabaseAdmin
      .from('supply_invoices')
      .select(`
        *,
        supply_clients(id, name, phone, address, city, pincode, gstin),
        supply_orders(order_number, delivery_date, status,
          supply_order_items(
            id, ordered_qty, delivered_qty, unit_price,
            supply_catalog_items(name, unit, hsn_code, gst_rate)
          )
        )
      `)
      .eq('id', id)
      .eq('supplier_id', supplierId)
      .maybeSingle();

    if (error || !invoice) return res.status(404).json({ error: 'Invoice not found' });

    res.json({ invoice });
  } catch (err) {
    console.error('[invoices] GET single error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/supply/invoices/:id/pdf ─────────────────────────────────────────
// Returns a fresh 48-hour signed URL for the invoice PDF.
router.get('/:id/pdf', authenticateSupplyToken, async (req, res) => {
  try {
    const { id }     = req.params;
    const supplierId = req.supplier.id;

    const { data: invoice } = await supabaseAdmin
      .from('supply_invoices')
      .select('invoice_number, pdf_url')
      .eq('id', id)
      .eq('supplier_id', supplierId)
      .maybeSingle();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    if (!invoice.pdf_url) {
      return res.status(404).json({ error: 'PDF not yet generated for this invoice' });
    }

    // Regenerate signed URL (48 hr)
    const storagePath = `${supplierId}/${invoice.invoice_number}.pdf`;
    const bucket      = process.env.SUPPLY_STORAGE_BUCKET_INVOICES || 'supply-invoices';
    const { data }    = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrl(storagePath, 172800);

    res.json({ signed_url: data?.signedUrl, invoice_number: invoice.invoice_number });
  } catch (err) {
    console.error('[invoices] GET pdf error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/supply/invoices/:id/resend ─────────────────────────────────────
// Re-send invoice PDF to client's WhatsApp.
router.post('/:id/resend', authenticateSupplyToken, async (req, res) => {
  try {
    const { id }     = req.params;
    const supplierId = req.supplier.id;

    const { data: invoice } = await supabaseAdmin
      .from('supply_invoices')
      .select(`
        *, supply_clients(name, phone),
        supply_orders(order_number)
      `)
      .eq('id', id)
      .eq('supplier_id', supplierId)
      .maybeSingle();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!invoice.pdf_url) return res.status(400).json({ error: 'No PDF available to resend' });

    // Fresh signed URL
    const storagePath = `${supplierId}/${invoice.invoice_number}.pdf`;
    const bucket      = process.env.SUPPLY_STORAGE_BUCKET_INVOICES || 'supply-invoices';
    const { data: signed } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrl(storagePath, 172800);

    await notifyClient(supplierId, invoice.supply_clients.phone, 'supply_delivery_done_invoice', {
      order_number:   invoice.supply_orders?.order_number,
      invoice_number: invoice.invoice_number,
      grand_total:    invoice.total_amount,
      pdf_url:        signed?.signedUrl,
    }, invoice.client_id);

    await supabaseAdmin
      .from('supply_invoices')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', id);

    res.json({ success: true, signed_url: signed?.signedUrl });
  } catch (err) {
    console.error('[invoices] resend error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
