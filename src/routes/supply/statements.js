// src/routes/supply/statements.js
// ============================================================================
// MODULE 10 — Statement Engine
//
// POST   /api/supply/statements/generate/:client_id?month=YYYY-MM  — on-demand
// GET    /api/supply/statements/credit-book                         — all clients summary
// GET    /api/supply/statements/:client_id                          — list for one client
// GET    /api/supply/statements/:id/pdf                             — download redirect
// POST   /api/supply/statements/:id/resend                          — resend WhatsApp
//
// Auto-trigger (1st of month, 8 AM IST) is handled by Module 13 scheduler,
// which calls generateStatement() exported from this file.
//
// PDF generation: PDFKit (inline, no Puppeteer dependency)
// Storage:        Supabase Storage bucket `supply-statements`
//                 Path: {supplier_id}/{client_id}/{YYYY-MM}.pdf
// ============================================================================

'use strict';

const express  = require('express');
const router   = express.Router();
const PDFDocument = require('pdfkit');
const { supabaseAdmin } = require('../../config/supabase');
const { supplyAuthMiddleware: auth } = require('../../middleware/supplyAuth');
const { notifyClient } = require('./notify');

// ── Constants ─────────────────────────────────────────────────────────────────
const BUCKET = process.env.SUPPLY_STORAGE_BUCKET_STATEMENTS || 'supply-statements';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the first and last day of a month string 'YYYY-MM'.
 * e.g. '2025-06' → { start: '2025-06-01', end: '2025-06-30' }
 */
function monthBounds(month) {
  const [year, mon] = month.split('-').map(Number);
  const start = new Date(year, mon - 1, 1);
  const end   = new Date(year, mon, 0);           // last day of month
  return {
    start: start.toISOString().slice(0, 10),
    end:   end.toISOString().slice(0, 10),
  };
}

/**
 * Fetch ledger entries for a client within a date range.
 * Joins order and payment_claim references for display.
 */
async function fetchLedgerEntries(clientId, supplierId, startDate, endDate) {
  const { data, error } = await supabaseAdmin
    .from('supply_credit_ledger')
    .select(`
      id, entry_date, type, amount, balance_after, note,
      order_id, payment_claim_id,
      supply_orders!supply_credit_ledger_order_id_fkey(order_number, delivery_date),
      supply_payment_claims!supply_credit_ledger_payment_claim_id_fkey(method, reference)
    `)
    .eq('client_id', clientId)
    .eq('supplier_id', supplierId)
    .gte('entry_date', startDate)
    .lte('entry_date', endDate)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Ledger fetch failed: ${error.message}`);
  return data || [];
}

/**
 * Fetch invoice GST summary for the period.
 */
async function fetchInvoiceSummary(clientId, supplierId, startDate, endDate) {
  const { data, error } = await supabaseAdmin
    .from('supply_invoices')
    .select('taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, invoice_number, invoice_date')
    .eq('client_id', clientId)
    .eq('supplier_id', supplierId)
    .gte('invoice_date', startDate)
    .lte('invoice_date', endDate)
    .order('invoice_date', { ascending: true });

  if (error) throw new Error(`Invoice fetch failed: ${error.message}`);
  return data || [];
}

/**
 * Get the opening balance — balance_after of the last entry BEFORE the period.
 */
async function getOpeningBalance(clientId, supplierId, startDate) {
  const { data } = await supabaseAdmin
    .from('supply_credit_ledger')
    .select('balance_after')
    .eq('client_id', clientId)
    .eq('supplier_id', supplierId)
    .lt('entry_date', startDate)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data ? parseFloat(data.balance_after) : 0;
}

/**
 * Build PDF buffer for a statement.
 * Returns a Buffer.
 */
async function buildStatementPDF({ supplier, client, month, openingBalance, entries, invoices }) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];

    doc.on('data',  chunk => chunks.push(chunk));
    doc.on('end',   ()    => resolve(Buffer.concat(chunks)));
    doc.on('error', err   => reject(err));

    const fmt = (n) => `₹${parseFloat(n || 0).toFixed(2)}`;
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-IN') : '';
    const [year, mon] = month.split('-');
    const monthLabel  = new Date(year, parseInt(mon) - 1, 1)
      .toLocaleString('en-IN', { month: 'long', year: 'numeric' });

    // ── Header ──────────────────────────────────────────────────────────────
    doc.fontSize(18).font('Helvetica-Bold').text('ACCOUNT STATEMENT', { align: 'center' });
    doc.moveDown(0.5);

    doc.fontSize(10).font('Helvetica');
    doc.text(`From: ${supplier.business_name}`, 50);
    if (supplier.address) doc.text(`       ${supplier.address}, ${supplier.city || ''} ${supplier.pincode || ''}`);
    if (supplier.gstin)   doc.text(`       GSTIN: ${supplier.gstin}`);
    doc.moveDown(0.3);
    doc.text(`To:   ${client.name}`, 50);
    if (client.address)   doc.text(`       ${client.address}, ${client.city || ''} ${client.pincode || ''}`);
    if (client.gstin)     doc.text(`       GSTIN: ${client.gstin}`);
    doc.moveDown(0.3);
    doc.text(`Period: ${monthLabel}`);
    doc.moveDown(0.5);

    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    // ── Opening Balance ──────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').text(`Opening Balance: ${fmt(openingBalance)}`, { align: 'right' });
    doc.moveDown(0.5);

    // ── Transactions ─────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(11).text('Transactions');
    doc.moveDown(0.3);

    // Table header
    const col = { date: 50, desc: 120, type: 350, amount: 420, balance: 480 };
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('Date',        col.date,   doc.y, { continued: true });
    doc.text('Description', col.desc,   doc.y, { continued: true });
    doc.text('Type',        col.type,   doc.y, { continued: true });
    doc.text('Amount',      col.amount, doc.y, { continued: true });
    doc.text('Balance',     col.balance, doc.y);
    doc.moveDown(0.2);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.2);

    doc.font('Helvetica').fontSize(9);

    let totalDebits  = 0;
    let totalCredits = 0;

    for (const entry of entries) {
      const order   = entry.supply_orders;
      const claim   = entry.supply_payment_claims;
      let desc = entry.note || '';
      if (entry.type === 'debit'  && order)  desc = `Order #${order.order_number}`;
      if (entry.type === 'credit' && claim)  desc = `Payment (${claim.method || 'manual'})${claim.reference ? ' Ref:' + claim.reference : ''}`;

      const y = doc.y;
      doc.text(fmtDate(entry.entry_date), col.date,    y, { width: 65,  continued: false });
      doc.text(desc,                      col.desc,    y, { width: 225, continued: false });
      doc.text(entry.type.toUpperCase(),  col.type,    y, { width: 60,  continued: false });
      doc.text(fmt(entry.amount),         col.amount,  y, { width: 55,  continued: false });
      doc.text(fmt(entry.balance_after),  col.balance, y, { width: 65,  continued: false });
      doc.moveDown(0.4);

      if (entry.type === 'debit')  totalDebits  += parseFloat(entry.amount);
      if (entry.type === 'credit') totalCredits += parseFloat(entry.amount);
    }

    if (entries.length === 0) {
      doc.text('No transactions in this period.', { align: 'center' });
      doc.moveDown(0.5);
    }

    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    const closingBalance = openingBalance + totalDebits - totalCredits;

    // ── Summary ───────────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text(`Opening Balance:  ${fmt(openingBalance)}`,  { align: 'right' });
    doc.text(`Total Debits:     ${fmt(totalDebits)}`,     { align: 'right' });
    doc.text(`Total Credits:    ${fmt(totalCredits)}`,    { align: 'right' });
    doc.moveDown(0.3);
    doc.fontSize(12).text(`Closing Balance:  ${fmt(closingBalance)}`, { align: 'right' });
    doc.moveDown(0.5);

    if (client.credit_terms_days) {
      const dueDate = new Date(year, parseInt(mon), client.credit_terms_days);
      doc.fontSize(10).font('Helvetica')
        .text(`Payment due by: ${fmtDate(dueDate.toISOString().slice(0, 10))}`, { align: 'right' });
    }

    doc.moveDown(1);

    // ── GST Summary ───────────────────────────────────────────────────────────
    if (invoices.length > 0) {
      doc.font('Helvetica-Bold').fontSize(11).text('GST Summary');
      doc.moveDown(0.3);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.3);

      let gstTaxable = 0, gstCgst = 0, gstSgst = 0, gstIgst = 0;
      for (const inv of invoices) {
        gstTaxable += parseFloat(inv.taxable_amount || 0);
        gstCgst    += parseFloat(inv.cgst_amount    || 0);
        gstSgst    += parseFloat(inv.sgst_amount    || 0);
        gstIgst    += parseFloat(inv.igst_amount    || 0);
      }

      doc.fontSize(10).font('Helvetica');
      doc.text(`Total Taxable Value: ${fmt(gstTaxable)}`);
      if (gstCgst > 0 || gstSgst > 0) {
        doc.text(`CGST:                ${fmt(gstCgst)}`);
        doc.text(`SGST:                ${fmt(gstSgst)}`);
      }
      if (gstIgst > 0) {
        doc.text(`IGST:                ${fmt(gstIgst)}`);
      }
      doc.font('Helvetica-Bold')
        .text(`Total GST:           ${fmt(gstCgst + gstSgst + gstIgst)}`);
    }

    doc.moveDown(2);
    doc.fontSize(8).font('Helvetica').fillColor('grey')
      .text('Generated by Munafe Supply · autom8.works', { align: 'center' });

    doc.end();
  });
}

/**
 * Core generation logic — called by both the API route and Module 13 scheduler.
 * Returns the saved supply_statements row.
 */
async function generateStatement(supplierId, clientId, month) {
  // ── 1. Fetch supplier + client ────────────────────────────────────────────
  const { data: supplier, error: supErr } = await supabaseAdmin
    .from('suppliers')
    .select('id, name, business_name, address, city, state, pincode, gstin, waba_phone')
    .eq('id', supplierId)
    .maybeSingle();
  if (supErr || !supplier) throw new Error('Supplier not found');

  const { data: client, error: cliErr } = await supabaseAdmin
    .from('supply_clients')
    .select('id, name, phone, gstin, address, city, pincode, credit_terms_days, credit_limit')
    .eq('id', clientId)
    .eq('supplier_id', supplierId)
    .maybeSingle();
  if (cliErr || !client) throw new Error('Client not found');

  // ── 2. Build period bounds ────────────────────────────────────────────────
  const { start: startDate, end: endDate } = monthBounds(month);

  // ── 3. Gather data ────────────────────────────────────────────────────────
  const [openingBalance, entries, invoices] = await Promise.all([
    getOpeningBalance(clientId, supplierId, startDate),
    fetchLedgerEntries(clientId, supplierId, startDate, endDate),
    fetchInvoiceSummary(clientId, supplierId, startDate, endDate),
  ]);

  // ── 4. Compute totals ────────────────────────────────────────────────────
  let totalDebits  = 0;
  let totalCredits = 0;
  for (const e of entries) {
    if (e.type === 'debit')  totalDebits  += parseFloat(e.amount);
    if (e.type === 'credit') totalCredits += parseFloat(e.amount);
  }
  const closingBalance = openingBalance + totalDebits - totalCredits;

  // ── 5. Upsert statement record (before PDF so we have the ID) ─────────────
  const { data: stmt, error: upsertErr } = await supabaseAdmin
    .from('supply_statements')
    .upsert({
      supplier_id:     supplierId,
      client_id:       clientId,
      period_start:    startDate,
      period_end:      endDate,
      opening_balance: openingBalance,
      total_debits:    totalDebits,
      total_credits:   totalCredits,
      closing_balance: closingBalance,
    }, { onConflict: 'supplier_id,client_id,period_start' })
    .select()
    .single();

  if (upsertErr) throw new Error(`Statement upsert failed: ${upsertErr.message}`);

  // ── 6. Generate PDF ───────────────────────────────────────────────────────
  const pdfBuffer = await buildStatementPDF({
    supplier, client, month, openingBalance, entries, invoices,
  });

  // ── 7. Upload to Supabase Storage ─────────────────────────────────────────
  const storagePath = `${supplierId}/${clientId}/${month}.pdf`;
  const { error: uploadErr } = await supabaseAdmin
    .storage
    .from(BUCKET)
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert:      true,
    });

  if (uploadErr) throw new Error(`PDF upload failed: ${uploadErr.message}`);

  // ── 8. Get signed URL (48hr) and permanent URL ───────────────────────────
  const { data: signedData } = await supabaseAdmin
    .storage
    .from(BUCKET)
    .createSignedUrl(storagePath, 172800); // 48 hours

  const { data: publicData } = supabaseAdmin
    .storage
    .from(BUCKET)
    .getPublicUrl(storagePath);

  const pdfUrl    = publicData?.publicUrl  || null;
  const signedUrl = signedData?.signedUrl  || null;

  // ── 9. Update statement row with PDF URL ──────────────────────────────────
  await supabaseAdmin
    .from('supply_statements')
    .update({ pdf_path: storagePath, pdf_url: pdfUrl })
    .eq('id', stmt.id);

  return { ...stmt, pdf_url: pdfUrl, signed_url: signedUrl, client, supplier };
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/supply/statements/generate/:client_id?month=YYYY-MM
 * On-demand generation for a specific client + month.
 * Defaults to previous calendar month if ?month is omitted.
 */
router.post('/generate/:client_id', auth, async (req, res) => {
  try {
    const { client_id } = req.params;
    const supplierId    = req.supplier_id;

    // Default: previous month
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const defaultMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    const month = req.query.month || defaultMonth;

    // Validate month format
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }

    const result = await generateStatement(supplierId, client_id, month);
    res.json({ ok: true, statement: result });
  } catch (err) {
    console.error('[statements] generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/supply/statements/credit-book
 * Full credit book: all active clients with outstanding balance, days overdue, etc.
 * Supports sort=balance|overdue and filter=overdue.
 */
router.get('/credit-book', auth, async (req, res) => {
  try {
    const supplierId = req.supplier_id;
    const { filter, sort = 'balance' } = req.query;

    // Fetch all active clients
    const { data: clients, error: cliErr } = await supabaseAdmin
      .from('supply_clients')
      .select('id, name, phone, credit_limit, credit_terms_days, credit_auto_block')
      .eq('supplier_id', supplierId)
      .eq('is_active', true)
      .order('name');

    if (cliErr) return res.status(500).json({ error: cliErr.message });

    // For each client: get current balance + oldest unpaid invoice
    const rows = await Promise.all(clients.map(async (client) => {
      // Current balance from ledger
      const { data: latest } = await supabaseAdmin
        .from('supply_credit_ledger')
        .select('balance_after')
        .eq('client_id', client.id)
        .eq('supplier_id', supplierId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const outstanding = latest ? parseFloat(latest.balance_after) : 0;

      // Oldest unresolved order for "days outstanding"
      const { data: oldestOrder } = await supabaseAdmin
        .from('supply_orders')
        .select('delivery_date')
        .eq('client_id', client.id)
        .eq('supplier_id', supplierId)
        .in('status', ['delivered', 'partially_delivered'])
        .order('delivery_date', { ascending: true })
        .limit(1)
        .maybeSingle();

      let daysOutstanding = 0;
      let isOverdue       = false;
      if (oldestOrder && outstanding > 0) {
        const deliveryDate = new Date(oldestOrder.delivery_date);
        const dueDate      = new Date(deliveryDate);
        dueDate.setDate(dueDate.getDate() + (client.credit_terms_days || 30));
        daysOutstanding = Math.max(0, Math.floor((Date.now() - deliveryDate.getTime()) / 86400000));
        isOverdue       = Date.now() > dueDate.getTime();
      }

      const creditAvailable = client.credit_limit > 0
        ? Math.max(0, client.credit_limit - outstanding)
        : null; // unlimited

      return {
        client_id:       client.id,
        name:            client.name,
        phone:           client.phone,
        outstanding,
        credit_limit:    client.credit_limit,
        credit_available: creditAvailable,
        credit_terms_days: client.credit_terms_days,
        days_outstanding: daysOutstanding,
        is_overdue:       isOverdue,
        credit_blocked:   client.credit_auto_block && client.credit_limit > 0 && outstanding >= client.credit_limit,
      };
    }));

    // Filter
    let result = rows;
    if (filter === 'overdue') result = rows.filter(r => r.is_overdue);

    // Sort
    if (sort === 'balance') result.sort((a, b) => b.outstanding - a.outstanding);
    if (sort === 'overdue') result.sort((a, b) => b.days_outstanding - a.days_outstanding);

    // Totals
    const totals = {
      total_outstanding: result.reduce((s, r) => s + r.outstanding, 0),
      overdue_count:     result.filter(r => r.is_overdue).length,
      blocked_count:     result.filter(r => r.credit_blocked).length,
    };

    res.json({ ok: true, clients: result, totals });
  } catch (err) {
    console.error('[statements] credit-book error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/supply/statements/:client_id
 * List all statements for a specific client (most recent first).
 */
router.get('/:client_id', auth, async (req, res) => {
  try {
    const { client_id } = req.params;
    const supplierId    = req.supplier_id;

    const { data, error } = await supabaseAdmin
      .from('supply_statements')
      .select('id, period_start, period_end, opening_balance, total_debits, total_credits, closing_balance, pdf_url, sent_to_client, sent_at, created_at')
      .eq('client_id', client_id)
      .eq('supplier_id', supplierId)
      .order('period_start', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, statements: data });
  } catch (err) {
    console.error('[statements] list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/supply/statements/:id/pdf
 * Returns a short-lived signed URL for the statement PDF.
 * Frontend should redirect to this URL or open in new tab.
 */
router.get('/:id/pdf', auth, async (req, res) => {
  try {
    const { id }     = req.params;
    const supplierId = req.supplier_id;

    const { data: stmt, error } = await supabaseAdmin
      .from('supply_statements')
      .select('id, supplier_id, client_id, period_start, pdf_path')
      .eq('id', id)
      .eq('supplier_id', supplierId)
      .maybeSingle();

    if (error || !stmt) return res.status(404).json({ error: 'Statement not found' });
    if (!stmt.pdf_path) return res.status(404).json({ error: 'PDF not yet generated' });

    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(BUCKET)
      .createSignedUrl(stmt.pdf_path, 172800); // 48hr

    if (signErr) return res.status(500).json({ error: signErr.message });

    res.json({ ok: true, url: signed.signedUrl });
  } catch (err) {
    console.error('[statements] pdf error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/supply/statements/:id/resend
 * Re-sends the statement PDF to the client via WhatsApp.
 * Module 12 (notify.js) must be wired before this fully works;
 * for now it marks sent_at and returns the signed URL so the caller can send.
 */
router.post('/:id/resend', auth, async (req, res) => {
  try {
    const { id }     = req.params;
    const supplierId = req.supplier_id;

    const { data: stmt, error } = await supabaseAdmin
      .from('supply_statements')
      .select('id, supplier_id, client_id, period_start, closing_balance, pdf_path, supply_clients(name, phone)')
      .eq('id', id)
      .eq('supplier_id', supplierId)
      .maybeSingle();

    if (error || !stmt) return res.status(404).json({ error: 'Statement not found' });
    if (!stmt.pdf_path) return res.status(400).json({ error: 'PDF not generated yet. Generate first.' });

    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(BUCKET)
      .createSignedUrl(stmt.pdf_path, 172800);

    if (signErr) return res.status(500).json({ error: signErr.message });

    const periodLabel = new Date(stmt.period_start).toLocaleString('en-IN', {
      month: 'long',
      year: 'numeric',
    });

    const notifyResult = await notifyClient(supplierId, stmt.supply_clients.phone, 'supply_monthly_statement', {
      period: periodLabel,
      closing_balance: stmt.closing_balance,
      pdf_url: signed.signedUrl,
    }, stmt.client_id);

    if (!notifyResult.ok) {
      throw new Error(`WhatsApp notify failed: ${notifyResult.error}`);
    }

    await supabaseAdmin
      .from('supply_statements')
      .update({ sent_to_client: true, sent_at: new Date().toISOString() })
      .eq('id', id);

    res.json({
      ok: true,
      signed_url: signed.signedUrl,
      client: stmt.supply_clients,
      message: 'Statement resent successfully via WhatsApp.',
    });
  } catch (err) {
    console.error('[statements] resend error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = Object.assign(router, { generateStatement });
