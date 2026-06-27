// src/routes/supply/ledger.js
// ============================================================================
// MODULE 7 — Credit Ledger
//
// GET    /api/supply/ledger/:client_id             — paginated ledger entries
// GET    /api/supply/ledger/:client_id/balance     — current balance + utilisation
// POST   /api/supply/ledger/:client_id/debit       — called internally by Module 6
// POST   /api/supply/ledger/:client_id/credit      — called internally by Module 8
// GET    /api/supply/ledger/:client_id/export      — CSV download
//
// Credit alert thresholds: 80%, 90%, 100% of credit_limit
// Duplicate alert suppression via supply_credit_alerts_log
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const { supplyAuthMiddleware: authenticateSupplyToken } = require('../../middleware/supplyAuth');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the current outstanding balance for a client.
 * Uses `balance_after` of the most recent ledger entry (denormalized fast path).
 * Falls back to SUM(debits) - SUM(credits) if no entries exist.
 */
async function getCurrentBalance(clientId) {
  const { data: latest } = await supabaseAdmin
    .from('supply_credit_ledger')
    .select('balance_after')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latest) return parseFloat(latest.balance_after);

  // Fallback: compute from raw entries
  const { data: debits } = await supabaseAdmin
    .from('supply_credit_ledger')
    .select('amount')
    .eq('client_id', clientId)
    .eq('type', 'debit');

  const { data: credits } = await supabaseAdmin
    .from('supply_credit_ledger')
    .select('amount')
    .eq('client_id', clientId)
    .eq('type', 'credit');

  const totalDebits  = (debits  || []).reduce((s, r) => s + parseFloat(r.amount), 0);
  const totalCredits = (credits || []).reduce((s, r) => s + parseFloat(r.amount), 0);
  return totalDebits - totalCredits;
}

/**
 * Checks utilisation thresholds and fires alerts if a new threshold is crossed.
 * Deduplication: only one alert per (client_id, alert_type) per day.
 *
 * Returns array of alert_types fired so the caller can send WhatsApp notifications.
 */
async function checkAndFireCreditAlerts(supplierId, clientId, newBalance, creditLimit) {
  if (!creditLimit || creditLimit <= 0) return []; // unlimited credit

  const utilisation = (newBalance / creditLimit) * 100;
  const thresholds = [
    { pct: 100, type: 'CREDIT_100' },
    { pct: 90,  type: 'CREDIT_90'  },
    { pct: 80,  type: 'CREDIT_80'  },
  ];

  const firedAlerts = [];

  for (const { pct, type } of thresholds) {
    if (utilisation < pct) continue;

    // Check if already fired today for this threshold
    const today = new Date().toISOString().slice(0, 10);
    const { data: existing } = await supabaseAdmin
      .from('supply_credit_alerts_log')
      .select('id')
      .eq('client_id', clientId)
      .eq('alert_type', type)
      .gte('fired_at', `${today}T00:00:00Z`)
      .maybeSingle();

    if (existing) continue; // already alerted today

    await supabaseAdmin.from('supply_credit_alerts_log').insert({
      supplier_id:    supplierId,
      client_id:      clientId,
      alert_type:     type,
      balance_at_fire: newBalance,
    });

    firedAlerts.push(type);
    break; // fire only the highest threshold that triggers
  }

  return firedAlerts;
}

async function createDebit(supplierId, clientId, orderId, amount, note = 'Order placed') {
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('supply_clients')
    .select('id, credit_limit, credit_auto_block')
    .eq('id', clientId)
    .eq('supplier_id', supplierId)
    .maybeSingle();

  if (clientErr) throw clientErr;
  if (!client) throw new Error('Client not found');

  const currentBalance = await getCurrentBalance(clientId);
  const newBalance = currentBalance + parseFloat(amount);
  const creditLimit = parseFloat(client.credit_limit) || 0;

  if (client.credit_auto_block && creditLimit > 0 && newBalance > creditLimit) {
    const error = new Error('Order would exceed client credit limit');
    error.code = 'credit_limit_exceeded';
    error.details = {
      current_balance: currentBalance,
      credit_limit: creditLimit,
      order_amount: parseFloat(amount),
    };
    throw error;
  }

  const today = new Date().toISOString().slice(0, 10);
  const { data: entry, error: insertErr } = await supabaseAdmin
    .from('supply_credit_ledger')
    .insert({
      supplier_id:  supplierId,
      client_id:    clientId,
      entry_date:   today,
      type:         'debit',
      amount:       parseFloat(amount),
      balance_after: newBalance,
      order_id:     orderId,
      note,
    })
    .select()
    .single();

  if (insertErr) throw insertErr;

  await checkAndFireCreditAlerts(supplierId, clientId, newBalance, creditLimit);
  return { entry, new_balance: newBalance };
}

async function createCredit(supplierId, clientId, paymentClaimId, amount, note = 'Payment credit') {
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('supply_clients')
    .select('id')
    .eq('id', clientId)
    .eq('supplier_id', supplierId)
    .maybeSingle();

  if (clientErr) throw clientErr;
  if (!client) throw new Error('Client not found');

  const currentBalance = await getCurrentBalance(clientId);
  const newBalance = Math.max(0, currentBalance - parseFloat(amount));
  const today = new Date().toISOString().slice(0, 10);

  const { data: entry, error: insertErr } = await supabaseAdmin
    .from('supply_credit_ledger')
    .insert({
      supplier_id:      supplierId,
      client_id:        clientId,
      entry_date:       today,
      type:             'credit',
      amount:           parseFloat(amount),
      balance_after:    newBalance,
      payment_claim_id: paymentClaimId || null,
      note,
    })
    .select()
    .single();

  if (insertErr) throw insertErr;
  return { entry, new_balance: newBalance };
}

async function adjustDebit(orderId, clientId, supplierId, oldAmount, newAmount) {
  const diff = parseFloat(newAmount) - parseFloat(oldAmount);
  if (Math.abs(diff) < 0.01) return { new_balance: await getCurrentBalance(clientId) };

  const { data: client, error: clientErr } = await supabaseAdmin
    .from('supply_clients')
    .select('credit_limit, credit_auto_block')
    .eq('id', clientId)
    .eq('supplier_id', supplierId)
    .maybeSingle();

  if (clientErr) throw clientErr;
  if (!client) throw new Error('Client not found');

  const currentBalance = await getCurrentBalance(clientId);
  const balanceAfter = currentBalance + diff;
  const creditLimit = parseFloat(client.credit_limit) || 0;

  if (diff > 0 && client.credit_auto_block && creditLimit > 0 && balanceAfter > creditLimit) {
    const error = new Error('Order adjustment would exceed client credit limit');
    error.code = 'credit_limit_exceeded';
    error.details = {
      current_balance: currentBalance,
      credit_limit: creditLimit,
      adjustment: diff,
    };
    throw error;
  }

  const today = new Date().toISOString().slice(0, 10);
  const { error: insertErr } = await supabaseAdmin
    .from('supply_credit_ledger')
    .insert({
      supplier_id,
      client_id,
      entry_date:    today,
      type:          diff > 0 ? 'debit' : 'credit',
      amount:        Math.abs(diff),
      balance_after: balanceAfter,
      order_id:      orderId,
      note:          'Delivery quantity adjustment',
    });

  if (insertErr) throw insertErr;

  if (diff > 0) {
    await checkAndFireCreditAlerts(supplierId, clientId, balanceAfter, creditLimit);
  }

  return { new_balance: balanceAfter };
}

async function reverseDebit(orderId, clientId, supplierId, amount, note = 'Order cancellation reversal') {
  if (parseFloat(amount) <= 0) return { new_balance: await getCurrentBalance(clientId) };

  const currentBalance = await getCurrentBalance(clientId);
  const balanceAfter   = Math.max(0, currentBalance - parseFloat(amount));
  const today = new Date().toISOString().slice(0, 10);

  const { data: entry, error: insertErr } = await supabaseAdmin
    .from('supply_credit_ledger')
    .insert({
      supplier_id,
      client_id,
      entry_date:    today,
      type:          'credit',
      amount:        parseFloat(amount),
      balance_after: balanceAfter,
      order_id,
      note,
    })
    .select()
    .single();

  if (insertErr) throw insertErr;
  return { entry, new_balance: balanceAfter };
}

// ── GET /api/supply/ledger/:client_id ────────────────────────────────────────
// Paginated ledger entries for a client.
// Query params: page (default 1), per_page (default 20), type (debit|credit),
//               from (YYYY-MM-DD), to (YYYY-MM-DD)
router.get('/:client_id', authenticateSupplyToken, async (req, res) => {
  try {
    const { client_id } = req.params;
    const supplierId    = req.supplier.id;
    const { page = 1, per_page = 20, type, from, to } = req.query;
    const limit  = Math.min(parseInt(per_page), 100);
    const offset = (parseInt(page) - 1) * limit;

    // Verify client belongs to this supplier
    const { data: client, error: clientErr } = await supabaseAdmin
      .from('supply_clients')
      .select('id, name, credit_limit')
      .eq('id', client_id)
      .eq('supplier_id', supplierId)
      .maybeSingle();
    if (clientErr || !client) return res.status(404).json({ error: 'Client not found' });

    let q = supabaseAdmin
      .from('supply_credit_ledger')
      .select(`
        id, entry_date, type, amount, balance_after, note, created_at,
        order_id, payment_claim_id,
        supply_orders(order_number),
        supply_payment_claims(reference, method)
      `, { count: 'exact' })
      .eq('client_id', client_id)
      .eq('supplier_id', supplierId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (type) q = q.eq('type', type);
    if (from) q = q.gte('entry_date', from);
    if (to)   q = q.lte('entry_date', to);

    const { data: entries, count, error } = await q;
    if (error) throw error;

    const currentBalance = await getCurrentBalance(client_id);

    res.json({
      client: {
        id:           client.id,
        name:         client.name,
        credit_limit: client.credit_limit,
      },
      current_balance: currentBalance,
      utilisation_pct: client.credit_limit > 0
        ? Math.round((currentBalance / client.credit_limit) * 100)
        : null,
      entries,
      pagination: {
        page: parseInt(page),
        per_page: limit,
        total: count,
        total_pages: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    console.error('[ledger] GET entries error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/supply/ledger/:client_id/balance ────────────────────────────────
// Returns current balance + credit summary for a client.
router.get('/:client_id/balance', authenticateSupplyToken, async (req, res) => {
  try {
    const { client_id } = req.params;
    const supplierId    = req.supplier.id;

    const { data: client, error: clientErr } = await supabaseAdmin
      .from('supply_clients')
      .select('id, name, credit_limit, credit_terms_days, credit_auto_block')
      .eq('id', client_id)
      .eq('supplier_id', supplierId)
      .maybeSingle();
    if (clientErr || !client) return res.status(404).json({ error: 'Client not found' });

    const balance = await getCurrentBalance(client_id);
    const creditLimit   = parseFloat(client.credit_limit) || 0;
    const creditAvailable = creditLimit > 0 ? Math.max(0, creditLimit - balance) : null;
    const utilisationPct  = creditLimit > 0
      ? Math.round((balance / creditLimit) * 100)
      : null;

    res.json({
      client_id,
      client_name:      client.name,
      current_balance:  balance,
      credit_limit:     creditLimit,
      credit_available: creditAvailable,
      utilisation_pct:  utilisationPct,
      credit_auto_block: client.credit_auto_block,
      credit_terms_days: client.credit_terms_days,
      is_blocked: client.credit_auto_block && utilisationPct >= 100,
    });
  } catch (err) {
    console.error('[ledger] GET balance error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/supply/ledger/:client_id/debit ─────────────────────────────────
// Internal: called by Module 6 (order confirmed) to record a debit entry.
// Body: { order_id, amount, note? }
// Returns: { entry, alerts_fired, new_balance }
router.post('/:client_id/debit', authenticateSupplyToken, async (req, res) => {
  try {
    const { client_id } = req.params;
    const supplierId    = req.supplier.id;
    const { order_id, amount, note } = req.body;

    if (!order_id || !amount) {
      return res.status(400).json({ error: 'order_id and amount are required' });
    }

    const { data: client, error: clientErr } = await supabaseAdmin
      .from('supply_clients')
      .select('id, credit_limit, credit_auto_block')
      .eq('id', client_id)
      .eq('supplier_id', supplierId)
      .maybeSingle();
    if (clientErr || !client) return res.status(404).json({ error: 'Client not found' });

    const currentBalance = await getCurrentBalance(client_id);
    const newBalance     = currentBalance + parseFloat(amount);

    // Check credit block before writing
    const creditLimit = parseFloat(client.credit_limit) || 0;
    if (client.credit_auto_block && creditLimit > 0 && newBalance > creditLimit) {
      return res.status(422).json({
        error: 'credit_limit_exceeded',
        message: 'Order would exceed client credit limit',
        current_balance: currentBalance,
        credit_limit:    creditLimit,
        order_amount:    parseFloat(amount),
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const { data: entry, error: insertErr } = await supabaseAdmin
      .from('supply_credit_ledger')
      .insert({
        supplier_id:  supplierId,
        client_id,
        entry_date:   today,
        type:         'debit',
        amount:       parseFloat(amount),
        balance_after: newBalance,
        order_id,
        note: note || `Order debit`,
      })
      .select()
      .single();
    if (insertErr) throw insertErr;

    // Fire credit utilisation alerts
    const alertsFired = await checkAndFireCreditAlerts(supplierId, client_id, newBalance, creditLimit);

    res.json({ entry, new_balance: newBalance, alerts_fired: alertsFired });
  } catch (err) {
    console.error('[ledger] POST debit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/supply/ledger/:client_id/credit ────────────────────────────────
// Internal: called by Module 8 (payment confirmed) to record a credit entry.
// Body: { payment_claim_id, amount, note? }
router.post('/:client_id/credit', authenticateSupplyToken, async (req, res) => {
  try {
    const { client_id } = req.params;
    const supplierId    = req.supplier.id;
    const { payment_claim_id, amount, note } = req.body;

    if (!amount) return res.status(400).json({ error: 'amount is required' });

    const { data: client } = await supabaseAdmin
      .from('supply_clients')
      .select('id')
      .eq('id', client_id)
      .eq('supplier_id', supplierId)
      .maybeSingle();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const currentBalance = await getCurrentBalance(client_id);
    const newBalance     = Math.max(0, currentBalance - parseFloat(amount));
    const today          = new Date().toISOString().slice(0, 10);

    const { data: entry, error: insertErr } = await supabaseAdmin
      .from('supply_credit_ledger')
      .insert({
        supplier_id:     supplierId,
        client_id,
        entry_date:      today,
        type:            'credit',
        amount:          parseFloat(amount),
        balance_after:   newBalance,
        payment_claim_id: payment_claim_id || null,
        note: note || 'Payment credit',
      })
      .select()
      .single();
    if (insertErr) throw insertErr;

    res.json({ entry, new_balance: newBalance });
  } catch (err) {
    console.error('[ledger] POST credit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/supply/ledger/:client_id/export ─────────────────────────────────
// Returns CSV of all ledger entries for a client.
// Query params: from, to (date range)
router.get('/:client_id/export', authenticateSupplyToken, async (req, res) => {
  try {
    const { client_id } = req.params;
    const supplierId    = req.supplier.id;
    const { from, to } = req.query;

    const { data: client } = await supabaseAdmin
      .from('supply_clients')
      .select('name')
      .eq('id', client_id)
      .eq('supplier_id', supplierId)
      .maybeSingle();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    let q = supabaseAdmin
      .from('supply_credit_ledger')
      .select(`
        entry_date, type, amount, balance_after, note, created_at,
        supply_orders(order_number),
        supply_payment_claims(reference)
      `)
      .eq('client_id', client_id)
      .eq('supplier_id', supplierId)
      .order('created_at', { ascending: true });

    if (from) q = q.gte('entry_date', from);
    if (to)   q = q.lte('entry_date', to);

    const { data: entries, error } = await q;
    if (error) throw error;

    const header = 'Date,Type,Reference,Amount,Balance After,Note\n';
    const rows = entries.map(e => {
      const ref = e.supply_orders?.order_number
        || e.supply_payment_claims?.reference
        || '';
      return [
        e.entry_date,
        e.type,
        ref,
        e.amount,
        e.balance_after,
        `"${(e.note || '').replace(/"/g, '""')}"`,
      ].join(',');
    });

    const csv = header + rows.join('\n');
    const filename = `ledger_${client.name.replace(/\s+/g, '_')}_${Date.now()}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('[ledger] GET export error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.createDebit = createDebit;
router.createCredit = createCredit;
router.adjustDebit = adjustDebit;
router.reverseDebit = reverseDebit;
router.getCurrentBalance = getCurrentBalance;
module.exports = router;
