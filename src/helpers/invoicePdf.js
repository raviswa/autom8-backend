'use strict';

/**
 * GST / FSSAI tax invoice or order receipt PDF.
 */

const PDFDocument = require('pdfkit');

function collectPdfBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function money(n) {
  return `Rs ${Number(n || 0).toFixed(2)}`;
}

/**
 * @param {object} opts
 * @param {object} opts.restaurant
 * @param {object} opts.payload — from buildInvoicePayload
 * @param {object} [opts.customer]
 */
async function buildInvoicePdf(opts) {
  const r = opts.restaurant || {};
  const p = opts.payload || {};
  const meta = p.invoice_meta || {};
  const fin = p.financial_breakdown || {};
  const lines = p.line_items || [];
  const customer = opts.customer || {};
  const hasGstin = !!(r.gstin || meta.gstin);
  const title = hasGstin ? 'TAX INVOICE' : 'ORDER INVOICE / RECEIPT';

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const done = collectPdfBuffer(doc);

  doc.fontSize(16).text(title, { align: 'center' });
  if (!hasGstin) {
    doc.fontSize(9).fillColor('#666').text(
      'Seller GSTIN not on file — this is a commercial receipt, not a GST tax invoice.',
      { align: 'center' },
    );
    doc.fillColor('#000');
  }
  doc.moveDown();

  doc.fontSize(12).text(r.legal_name || r.display_name || r.name || meta.store_name || 'Seller');
  doc.fontSize(9);
  const addr = [r.address_line1, r.address_line2, r.city, r.state, r.postal_code]
    .filter(Boolean)
    .join(', ');
  if (addr) doc.text(addr, { width: 280 });
  if (r.gstin || meta.gstin) doc.text(`GSTIN: ${r.gstin || meta.gstin}`);
  if (r.fssai_license) doc.text(`FSSAI: ${r.fssai_license}`);
  if (r.sac_code) doc.text(`SAC: ${r.sac_code}`);

  doc.moveDown(0.5);
  doc.fontSize(10).text(`Invoice #: ${meta.invoice_number || meta.order_number || meta.order_id || '—'}`);
  if (meta.order_number && meta.invoice_number && meta.invoice_number !== meta.order_number) {
    doc.fontSize(9).fillColor('#666').text(`Order: ${meta.order_number}`);
    doc.fillColor('#000').fontSize(10);
  }
  doc.text(`Date: ${(meta.invoice_date || new Date().toISOString()).slice(0, 10)}`);
  if (hasGstin && meta.place_of_supply && meta.place_of_supply !== 'unknown') {
    doc.text(`Place of supply: ${meta.place_of_supply === 'inter_state' ? 'Inter-state' : 'Intra-state'}`);
  }

  doc.moveDown(0.5);
  doc.fontSize(10).text('Bill to', { underline: true });
  doc.text(customer.name || customer.customer_name || 'Customer');
  if (customer.phone) doc.text(String(customer.phone));
  if (customer.address) doc.text(String(customer.address), { width: 280 });

  doc.moveDown();
  doc.fontSize(10).text('Items', { underline: true });
  doc.moveDown(0.2);
  for (const line of lines) {
    doc.fontSize(10).fillColor('#000').text(
      `${line.quantity || 1}× ${line.name || 'Item'} @ ${money(line.unit_price)} = ${money(line.line_total)}`,
    );
    const subDetails = [
      line.pack_size_label ? `Pack: ${line.pack_size_label}` : null,
      line.made_on_date ? `Made on: ${String(line.made_on_date).slice(0, 10)}` : null,
    ].filter(Boolean).join(' · ');
    if (subDetails) {
      doc.fontSize(8).fillColor('#666').text(subDetails);
      doc.fillColor('#000');
    }
  }

  doc.moveDown();
  doc.text(`Subtotal: ${money(fin.subtotal_base_price)}`);
  if (hasGstin) {
    if (fin.igst_amount != null) {
      doc.text(`IGST (${fin.igst_rate_pct || 0}%): ${money(fin.igst_amount)}`);
    } else {
      doc.text(`CGST (${fin.cgst_rate_pct || 0}%): ${money(fin.cgst_amount)}`);
      doc.text(`SGST (${fin.sgst_rate_pct || 0}%): ${money(fin.sgst_amount)}`);
    }
  }
  if (fin.packaging_or_delivery_charge) {
    doc.text(`Delivery / packaging: ${money(fin.packaging_or_delivery_charge)}`);
  }
  if (fin.round_off) doc.text(`Round off: ${money(fin.round_off)}`);
  doc.fontSize(12).text(`Grand total: ${money(fin.grand_total)}`);

  if (r.fssai_license) {
    doc.moveDown();
    doc.fontSize(8).fillColor('#444').text(
      'Packaged food: ensure FSSAI number, batch/lot and made-on date appear on product labels.',
      { width: 500 },
    );
  }

  return done;
}

module.exports = { buildInvoicePdf };
