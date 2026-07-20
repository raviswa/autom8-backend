'use strict';

/**
 * Packing slip + shipping label PDFs for packaged-food / shipped LOBs.
 */

const PDFDocument = require('pdfkit');

function money(n) {
  const v = Number(n || 0);
  return `Rs ${v.toFixed(2)}`;
}

function collectPdfBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/**
 * @param {object} payload
 * @param {object} payload.restaurant — name, phone, fssai, gstin, address bits
 * @param {object} payload.booking — order_ref, customer_name, customer_phone, delivery_address, meta
 * @param {Array}  payload.lines — [{ name, qty, pack, weight_grams, price }]
 */
async function buildPackingSlipPdf(payload) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const done = collectPdfBuffer(doc);

  const r = payload.restaurant || {};
  const b = payload.booking || {};
  const meta = b.meta || {};
  const lines = payload.lines || [];

  doc.fontSize(18).text(r.name || 'Packing slip', { continued: false });
  if (r.receipt_tagline) doc.fontSize(10).fillColor('#555').text(r.receipt_tagline);
  doc.fillColor('#000').fontSize(10).moveDown(0.3);
  const reg = [];
  if (r.fssai_license) reg.push(`FSSAI ${r.fssai_license}`);
  if (r.gstin) reg.push(`GSTIN ${r.gstin}`);
  if (reg.length) doc.text(reg.join('  ·  '));
  if (r.contact_phone || r.whatsapp_number) {
    doc.text(`Phone: ${r.contact_phone || r.whatsapp_number}`);
  }

  doc.moveDown();
  doc.fontSize(12).text(`Order: ${b.order_ref || b.id || '—'}`);
  doc.fontSize(10).text(`Date: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
  doc.moveDown(0.5);

  doc.fontSize(11).text('Ship to', { underline: true });
  doc.fontSize(10);
  doc.text(b.customer_name || meta.customer_name || 'Customer');
  doc.text(b.customer_phone || '');
  const addr = b.delivery_address || meta.delivery_address || '';
  if (addr) doc.text(addr, { width: 320 });
  if (meta.pincode || b.pincode) doc.text(`PIN ${meta.pincode || b.pincode}`);

  doc.moveDown();
  if (meta.awb || meta.courier_name) {
    doc.fontSize(11).text('Shipment', { underline: true });
    doc.fontSize(10);
    if (meta.courier_name) doc.text(`Courier: ${meta.courier_name}`);
    if (meta.awb) doc.text(`AWB: ${meta.awb}`);
    doc.moveDown();
  }

  doc.fontSize(11).text('Pack list', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10);
  let totalQty = 0;
  let totalWeight = 0;
  for (const line of lines) {
    const qty = Number(line.qty || 0);
    totalQty += qty;
    const w = Number(line.weight_grams || 0) * qty;
    totalWeight += w;
    const pack = line.pack ? ` (${line.pack})` : '';
    const wt = line.weight_grams ? ` · ${line.weight_grams}g` : '';
    doc.text(`${qty}×  ${line.name || 'Item'}${pack}${wt}`);
  }

  doc.moveDown();
  doc.text(`Lines: ${lines.length}  ·  Units: ${totalQty}  ·  Weight: ${(totalWeight / 1000).toFixed(2)} kg`);
  if (payload.packaging_weight_grams) {
    doc.text(`(+ packaging ${payload.packaging_weight_grams} g)`);
  }

  if (r.fssai_license) {
    doc.moveDown();
    doc.fontSize(9).fillColor('#444')
      .text('Ensure FSSAI number, batch/lot, and made-on date appear on each packed jar/label.', {
        width: 500,
      });
  }

  return done;
}

async function buildShippingLabelPdf(payload) {
  // 4x6-ish thermal friendly page
  const doc = new PDFDocument({ size: [288, 432], margin: 16 }); // 4x6 in points
  const done = collectPdfBuffer(doc);

  const r = payload.restaurant || {};
  const b = payload.booking || {};
  const meta = b.meta || {};

  doc.fontSize(14).text(meta.courier_name || 'SHIPPING LABEL', { align: 'center' });
  doc.moveDown(0.4);
  if (meta.awb) {
    doc.fontSize(16).text(String(meta.awb), { align: 'center' });
    doc.fontSize(9).text('AWB / Tracking', { align: 'center' });
  } else {
    doc.fontSize(10).fillColor('#666').text('AWB not assigned yet', { align: 'center' });
    doc.fillColor('#000');
  }

  doc.moveDown();
  doc.fontSize(9).text('FROM', { underline: true });
  doc.fontSize(10).text(r.name || '');
  if (r.postal_code) doc.fontSize(9).text(`PIN ${r.postal_code}`);
  if (r.fssai_license) doc.fontSize(8).text(`FSSAI ${r.fssai_license}`);

  doc.moveDown();
  doc.fontSize(9).text('TO', { underline: true });
  doc.fontSize(11).text(b.customer_name || meta.customer_name || 'Customer');
  doc.fontSize(10).text(b.customer_phone || '');
  const addr = b.delivery_address || meta.delivery_address || '';
  if (addr) doc.fontSize(9).text(addr, { width: 250 });
  if (meta.pincode || b.pincode) doc.fontSize(10).text(`PIN ${meta.pincode || b.pincode}`);

  doc.moveDown();
  doc.fontSize(9).text(`Order ${b.order_ref || b.id || ''}`);
  if (payload.weight_kg) doc.text(`Weight ${Number(payload.weight_kg).toFixed(2)} kg`);

  return done;
}

module.exports = {
  buildPackingSlipPdf,
  buildShippingLabelPdf,
  money,
};
