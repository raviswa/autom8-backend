// src/routes/supply/payment-claims.js
// ============================================================================
// MODULE 8 — Payment Claims
//
// POST   /api/supply/payment-claims              — WhatsApp bot creates claim
// GET    /api/supply/payment-claims              — supplier views all claims (?status=)
// PUT    /api/supply/payment-claims/:id/confirm  — supplier confirms → ledger credit
// PUT    /api/supply/payment-claims/:id/reject   — supplier rejects
// POST   /api/supply/payment-claims/manual       — supplier direct payment entry
//
// On confirm: calls Module 7 ledger credit internally + fires WhatsApp notification
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const { authenticateSupplyToken } = require('../../middleware/supplyAuth');
const { notifyClient } = require('./notify');

// ── Helper: post a credit entry to the ledger ─────────────────────────────────
async function postLedgerCredit(supplierId, clientId, paymentClaimId, amount, note) {
  // Replicate the balance logic from ledger.js (avoid circular require)
  const { data: latest } = await supabaseAdmin
    .from('supply_credit_ledger')
    .select('balance_after')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const currentBalance = latest ? parseFloat(latest.balance_after) : 0;
  const newBalance     = Math.max(0, currentBalance - parseFloat(amount));
  const today          = new Date().toISOString().slice(0, 10);

  const { data: entry, error } = await supabaseAdmin
    .from('supply_credit_ledger')
    .insert({
      supplier_id:     supplierId,
      client_id:       clientId,
      entry_date:      today,
      type:            'credit',
      amount:          parseFloat(amount),
      balance_after:   newBalance,
      payment_claim_id: paymentClaimId,
      note: note || 'Payment confirmed',
    })
    .select()
    .single();

  if (error) throw error;
  return { entry, new_balance: newBalance };
}

// ── POST /api/supply/payment-claims ──────────────────────────────────────────
// Called by WhatsApp bot (Module 11) when client says "I've paid".
// Uses supplier JWT (bot authenticates as supplier) OR an internal token.
// Body: { client_id, claimed_amount, method, reference?, raw_message? }
router.post('/', authenticateSupplyToken, async (req, res) => {
  try {
    const supplierId = req.supplier.id;
    const { client_id, claimed_amount, method, reference, raw_message } = req.body;

    if (!client_id || !claimed_amount) {
      return res.status(400).json({ error: 'client_id and claimed_amount are required' });
    }

    // Verify client belongs to supplier
    const { data: client } = await supabaseAdmin
      .from('supply_clients')
      .select('id, name, phone')
      .eq('id', client_id)
      .eq('supplier_id', supplierId)
      .maybeSingle();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { data: claim, error } = await supabaseAdmin
      .from('supply_payment_claims')
      .insert({
        supplier_id:    supplierId,
        client_id,
        claimed_amount: parseFloat(claimed_amount),
        method:         method || null,
        reference:      reference || null,
        raw_message:    raw_message || null,
        status:         'pending',
      })
      .select()
      .single();
    if (error) throw error;

    // Notify supplier of new pending claim
    const { data: supplier } = await supabaseAdmin
      .from('suppliers')
      .select('phone')
      .eq('id', supplierId)
      .maybeSingle();

    if (supplier?.phone) {
      await notifyClient(supplierId, supplier.phone, 'supply_payment_claim_alert', {
        client_name:    client.name,
        claimed_amount: parseFloat(claimed_amount),
        method,
        reference,
      }, client_id);
    }

    res.status(201).json({ claim });
  } catch (err) {
    console.error('[payment-claims] POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/supply/payment-claims ───────────────────────────────────────────
// Supplier views all claims, optionally filtered by status.
// Query: status (pending|confirmed|rejected), client_id, page, per_page
router.get('/', authenticateSupplyToken, async (req, res) => {
  try {
    const supplierId = req.supplier.id;
    const { status, client_id, page = 1, per_page = 25 } = req.query;
    const limit  = Math.min(parseInt(per_page), 100);
    const offset = (parseInt(page) - 1) * limit;

    let q = supabaseAdmin
      .from('supply_payment_claims')
      .select(`
        id, claimed_amount, method, reference, raw_message,
        status, supplier_note, claimed_at, resolved_at,
        supply_clients(id, name, phone)
      `, { count: 'exact' })
      .eq('supplier_id', supplierId)
      .order('claimed_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status)    q = q.eq('status', status);
    if (client_id) q = q.eq('client_id', client_id);

    const { data: claims, count, error } = await q;
    if (error) throw error;

    // Pending count badge for dashboard
    const { count: pendingCount } = await supabaseAdmin
      .from('supply_payment_claims')
      .select('id', { count: 'exact', head: true })
      .eq('supplier_id', supplierId)
      .eq('status', 'pending');

    res.json({
      claims,
      pending_count: pendingCount || 0,
      pagination: {
        page: parseInt(page),
        per_page: limit,
        total: count,
        total_pages: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    console.error('[payment-claims] GET list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/supply/payment-claims/:id/confirm ───────────────────────────────
// Supplier confirms claim → creates ledger credit → notifies client.
// Body: { supplier_note? }
router.put('/:id/confirm', authenticateSupplyToken, async (req, res) => {
  try {
    const supplierId    = req.supplier.id;
    const { id }        = req.params;
    const { supplier_note } = req.body;

    const { data: claim } = await supabaseAdmin
      .from('supply_payment_claims')
      .select('*, supply_clients(id, name, phone)')
      .eq('id', id)
      .eq('supplier_id', supplierId)
      .maybeSingle();
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    if (claim.status !== 'pending') {
      return res.status(409).json({ error: `Claim already ${claim.status}` });
    }

    // Post ledger credit
    const { new_balance } = await postLedgerCredit(
      supplierId,
      claim.client_id,
      id,
      claim.claimed_amount,
      `Payment confirmed${claim.reference ? ` (ref: ${claim.reference})` : ''}`,
    );

    // Update claim status
    const { data: updated, error } = await supabaseAdmin
      .from('supply_payment_claims')
      .update({
        status:       'confirmed',
        supplier_note: supplier_note || null,
        resolved_at:  new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    // Notify client
    await notifyClient(supplierId, claim.supply_clients.phone, 'supply_payment_confirmed', {
      amount:       claim.claimed_amount,
      method:       claim.method || 'manual',
      balance_after: new_balance,
    }, claim.client_id);

    res.json({ claim: updated, new_balance });
  } catch (err) {
    console.error('[payment-claims] confirm error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/supply/payment-claims/:id/reject ────────────────────────────────
// Supplier rejects claim. No ledger entry. Notifies client.
// Body: { supplier_note? }
router.put('/:id/reject', authenticateSupplyToken, async (req, res) => {
  try {
    const supplierId    = req.supplier.id;
    const { id }        = req.params;
    const { supplier_note } = req.body;

    const { data: claim } = await supabaseAdmin
      .from('supply_payment_claims')
      .select('*, supply_clients(id, name, phone)')
      .eq('id', id)
      .eq('supplier_id', supplierId)
      .maybeSingle();
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    if (claim.status !== 'pending') {
      return res.status(409).json({ error: `Claim already ${claim.status}` });
    }

    const { data: updated, error } = await supabaseAdmin
      .from('supply_payment_claims')
      .update({
        status:       'rejected',
        supplier_note: supplier_note || null,
        resolved_at:  new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    await notifyClient(supplierId, claim.supply_clients.phone, 'supply_payment_rejected', {
      amount: claim.claimed_amount,
      reason: supplier_note || 'Please contact your supplier',
    }, claim.client_id);

    res.json({ claim: updated });
  } catch (err) {
    console.error('[payment-claims] reject error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/supply/payment-claims/manual ───────────────────────────────────
// Supplier records a payment directly (no client claim).
// Creates a confirmed claim + ledger credit in one step.
// Body: { client_id, amount, method, reference?, note?, notify_client? }
router.post('/manual', authenticateSupplyToken, async (req, res) => {
  try {
    const supplierId = req.supplier.id;
    const { client_id, amount, method, reference, note, notify_client = true } = req.body;

    if (!client_id || !amount) {
      return res.status(400).json({ error: 'client_id and amount are required' });
    }

    const { data: client } = await supabaseAdmin
      .from('supply_clients')
      .select('id, name, phone')
      .eq('id', client_id)
      .eq('supplier_id', supplierId)
      .maybeSingle();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Create claim (already confirmed)
    const { data: claim, error: claimErr } = await supabaseAdmin
      .from('supply_payment_claims')
      .insert({
        supplier_id:    supplierId,
        client_id,
        claimed_amount: parseFloat(amount),
        method:         method || null,
        reference:      reference || null,
        raw_message:    null,
        status:         'confirmed',
        supplier_note:  note || 'Manual entry by supplier',
        resolved_at:    new Date().toISOString(),
      })
      .select()
      .single();
    if (claimErr) throw claimErr;

    // Post ledger credit
    const { new_balance } = await postLedgerCredit(
      supplierId,
      client_id,
      claim.id,
      parseFloat(amount),
      note || `Manual payment${reference ? ` (${reference})` : ''}`,
    );

    if (notify_client) {
      await notifyClient(supplierId, client.phone, 'supply_payment_confirmed', {
        amount:        parseFloat(amount),
        method:        method || 'manual',
        balance_after: new_balance,
      }, client_id);
    }

    res.status(201).json({ claim, new_balance });
  } catch (err) {
    console.error('[payment-claims] manual error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
