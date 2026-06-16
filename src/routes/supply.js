'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin } = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');
const { requireKdsSecret } = require('../middleware/internalAuth');
const {
  normalizePhone,
  buildB2bContext,
  resolveClientByPhone,
  getSupplierByPhoneNumberId,
  assertSupplierOwner,
  generateOrderNumber,
  appendLedgerDebit,
  checkCreditAlerts,
  getLedger,
  getOutstandingBalance,
  getNextDeliveryDate,
  isOrderingOpen,
  buildFormUrl,
  verifyFormToken,
} = require('../helpers/supplyContext');

async function requireSupplierOwner(req, res, next) {
  const supplierId = req.params.supplierId || req.body.supplier_id || req.query.supplier_id;
  if (!supplierId) return res.status(400).json({ error: 'supplier_id required' });
  const ok = await assertSupplierOwner(req.user.sub, supplierId);
  if (!ok) return res.status(403).json({ error: 'Not authorised for this supplier' });
  req.supplier_id = supplierId;
  next();
}

const dashboardAuth = [authenticateToken, requireSupplierOwner];

// ── Internal (Python chat) ───────────────────────────────────────────────────

router.get('/internal/context', requireKdsSecret, async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone);
    const supplierId = req.query.supplier_id;
    if (!phone || !supplierId) {
      return res.status(400).json({ error: 'phone and supplier_id required' });
    }
    const resolved = await resolveClientByPhone(phone, supplierId);
    if (!resolved) {
      const { data: supplier } = await supabaseAdmin
        .from('supply_suppliers')
        .select('*')
        .eq('id', supplierId)
        .maybeSingle();
      return res.json({
        is_known_client: false,
        supplier_name: supplier?.name ?? 'Supplier',
        supplier_phone: supplier?.phone ?? '',
      });
    }
    const ctx = await buildB2bContext(resolved.client, resolved.supplier);
    return res.json(ctx);
  } catch (err) {
    console.error('[supply/internal/context]', err);
    return res.status(500).json({ error: 'Failed to build context' });
  }
});

router.post('/internal/payment-claim', requireKdsSecret, async (req, res) => {
  try {
    const { client_id, claimed_amount, method, reference, raw_message } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });

    const { data: client } = await supabaseAdmin
      .from('supply_clients')
      .select('supplier_id')
      .eq('id', client_id)
      .single();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { data: claim, error } = await supabaseAdmin
      .from('supply_payment_claims')
      .insert({
        supplier_id: client.supplier_id,
        client_id,
        claimed_amount: claimed_amount ?? null,
        method: method ?? null,
        reference: reference ?? null,
        raw_message: raw_message ?? null,
        status: 'pending',
      })
      .select()
      .single();
    if (error) throw error;
    return res.json({ claim_id: claim.id, status: 'pending' });
  } catch (err) {
    console.error('[supply/internal/payment-claim]', err);
    return res.status(500).json({ error: 'Failed to log payment claim' });
  }
});

router.get('/internal/supplier-by-wa', requireKdsSecret, async (req, res) => {
  const supplier = await getSupplierByPhoneNumberId(req.query.phone_number_id);
  if (!supplier) return res.status(404).json({ error: 'Not a supply channel' });
  return res.json({
    supplier_id: supplier.id,
    name: supplier.name,
    phone: supplier.phone,
    whatsapp_phone_number_id: supplier.whatsapp_phone_number_id,
    whatsapp_access_token: supplier.whatsapp_access_token,
  });
});

// ── Public client lookup (internal secret or future admin) ───────────────────

router.get('/client/:phone', requireKdsSecret, async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const supplierId = req.query.supplier_id;
    const resolved = await resolveClientByPhone(phone, supplierId);
    if (!resolved) {
      return res.json({ is_known_client: false });
    }
    const ctx = await buildB2bContext(resolved.client, resolved.supplier);
    return res.json(ctx);
  } catch (err) {
    console.error('[supply/client]', err);
    return res.status(500).json({ error: 'Lookup failed' });
  }
});

// ── Order form resolve (public, token auth) ──────────────────────────────────

router.get('/form/resolve', async (req, res) => {
  try {
    const verified = verifyFormToken(req.query.t);
    if (!verified) return res.status(403).json({ error: 'Invalid form link' });
    if (verified.expired) return res.status(410).json({ error: 'Form link expired', expired: true });

    const { data: client } = await supabaseAdmin
      .from('supply_clients')
      .select('*, supply_suppliers(*)')
      .eq('id', verified.clientId)
      .eq('supplier_id', verified.supplierId)
      .maybeSingle();
    if (!client?.is_active) return res.status(404).json({ error: 'Client not found' });

    const supplier = client.supply_suppliers;
    delete client.supply_suppliers;

    const { data: catalog } = await supabaseAdmin
      .from('supply_catalog_items')
      .select('*')
      .eq('supplier_id', supplier.id)
      .eq('is_available', true)
      .order('display_order');

    const { data: prices } = await supabaseAdmin
      .from('supply_client_prices')
      .select('item_id, price')
      .eq('client_id', client.id);

    const priceMap = Object.fromEntries((prices ?? []).map(p => [p.item_id, Number(p.price)]));
    const items = (catalog ?? []).map(item => ({
      id: item.id,
      name: item.name,
      category: item.category,
      unit: item.unit,
      min_order_qty: item.min_order_qty,
      gst_rate: item.gst_rate,
      price: priceMap[item.id] ?? Number(item.default_price),
    }));

    const ctx = await buildB2bContext(client, supplier);
    const prefill = req.query.prefill === 'last' ? await getLastOrderItems(client.id) : null;

    return res.json({
      client: { id: client.id, name: client.name, gstin: client.gstin },
      supplier: { id: supplier.id, name: supplier.name },
      items,
      context: ctx,
      prefill,
      is_ordering_open: ctx.is_ordering_open,
    });
  } catch (err) {
    console.error('[supply/form/resolve]', err);
    return res.status(500).json({ error: 'Failed to load form' });
  }
});

async function getLastOrderItems(clientId) {
  const { data: last } = await supabaseAdmin
    .from('supply_orders')
    .select('id')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!last) return null;
  const { data: lines } = await supabaseAdmin
    .from('supply_order_items')
    .select('item_id, qty')
    .eq('order_id', last.id);
  return Object.fromEntries((lines ?? []).map(l => [l.item_id, Number(l.qty)]));
}

// ── Submit order (public, form token) ─────────────────────────────────────────

router.post('/orders', async (req, res) => {
  try {
    const { token, items, delivery_date, special_notes } = req.body;
    const verified = verifyFormToken(token);
    if (!verified || verified.expired) {
      return res.status(403).json({ error: verified?.expired ? 'Form link expired' : 'Invalid token' });
    }

    const { data: client } = await supabaseAdmin
      .from('supply_clients')
      .select('*, supply_suppliers(*)')
      .eq('id', verified.clientId)
      .maybeSingle();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const supplier = client.supply_suppliers;
    if (!isOrderingOpen(supplier)) {
      return res.status(403).json({ error: 'Ordering window is closed' });
    }

    const outstanding = await getOutstandingBalance(client.id);
    const limit = Number(client.credit_limit) || 0;
    const utilisation = limit > 0 ? Math.round((outstanding / limit) * 100) : 0;
    if (utilisation >= 100 && client.credit_auto_block !== false) {
      return res.status(403).json({ error: 'Credit limit reached — orders paused' });
    }

    const lineItems = (items ?? []).filter(i => Number(i.qty) > 0);
    if (!lineItems.length) return res.status(400).json({ error: 'No items in order' });

    const itemIds = lineItems.map(i => i.item_id);
    const { data: catalogRows } = await supabaseAdmin
      .from('supply_catalog_items')
      .select('*')
      .in('id', itemIds)
      .eq('supplier_id', supplier.id);

    const { data: priceRows } = await supabaseAdmin
      .from('supply_client_prices')
      .select('item_id, price')
      .eq('client_id', client.id)
      .in('item_id', itemIds);

    const catalogMap = Object.fromEntries((catalogRows ?? []).map(c => [c.id, c]));
    const priceMap = Object.fromEntries((priceRows ?? []).map(p => [p.item_id, Number(p.price)]));

    let totalAmount = 0;
    let gstAmount = 0;
    const orderLines = [];

    for (const line of lineItems) {
      const cat = catalogMap[line.item_id];
      if (!cat) continue;
      const qty = Number(line.qty);
      const unitPrice = priceMap[line.item_id] ?? Number(cat.default_price);
      const lineTotal = Math.round(unitPrice * qty * 100) / 100;
      const lineGst = Math.round(lineTotal * (Number(cat.gst_rate) / 100) * 100) / 100;
      totalAmount += lineTotal;
      gstAmount += lineGst;
      orderLines.push({
        item_id: cat.id,
        qty,
        unit: cat.unit,
        unit_price: unitPrice,
        line_total: lineTotal,
        gst_rate: cat.gst_rate,
        gst_amount: lineGst,
      });
    }

    const orderNumber = await generateOrderNumber(supplier.id);
    const deliveryDate = delivery_date || getNextDeliveryDate(client.delivery_days);

    const { data: order, error: orderErr } = await supabaseAdmin
      .from('supply_orders')
      .insert({
        supplier_id: supplier.id,
        client_id: client.id,
        order_number: orderNumber,
        delivery_date: deliveryDate,
        status: 'confirmed',
        total_amount: totalAmount,
        gst_amount: gstAmount,
        special_notes: special_notes ?? null,
        source: 'form',
      })
      .select()
      .single();
    if (orderErr) throw orderErr;

    const rows = orderLines.map(ol => ({ ...ol, order_id: order.id }));
    await supabaseAdmin.from('supply_order_items').insert(rows);

    const { balanceAfter } = await appendLedgerDebit({
      supplierId: supplier.id,
      clientId: client.id,
      amount: totalAmount,
      orderId: order.id,
      note: `Order ${orderNumber}`,
    });

    const newUtil = limit > 0 ? Math.round((balanceAfter / limit) * 100) : 0;
    await checkCreditAlerts(client.id, supplier.id, newUtil);

    return res.json({
      order_id: order.id,
      order_number: orderNumber,
      total_amount: totalAmount,
      new_outstanding: balanceAfter,
      delivery_date: deliveryDate,
    });
  } catch (err) {
    console.error('[supply/orders POST]', err);
    return res.status(500).json({ error: 'Failed to create order' });
  }
});

router.get('/form-url/:clientId', requireKdsSecret, async (req, res) => {
  try {
    const { data: client } = await supabaseAdmin
      .from('supply_clients')
      .select('*, supply_suppliers(*)')
      .eq('id', req.params.clientId)
      .maybeSingle();
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const url = buildFormUrl(client.id, client.supplier_id, client.supply_suppliers);
    return res.json({ order_form_url: url });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate URL' });
  }
});

router.get('/ledger/:clientId', requireKdsSecret, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 50);
  const entries = await getLedger(req.params.clientId, limit);
  return res.json({ entries });
});

router.get('/orders/:clientId', requireKdsSecret, async (req, res) => {
  let q = supabaseAdmin
    .from('supply_orders')
    .select('id, order_number, status, total_amount, delivery_date, created_at')
    .eq('client_id', req.params.clientId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (req.query.status === 'pending') {
    q = q.in('status', ['confirmed', 'out_for_delivery', 'partial']);
  }
  const { data } = await q;
  return res.json({ orders: data ?? [] });
});

// ── Supplier dashboard ─────────────────────────────────────────────────────────

router.get('/dashboard/:supplierId/clients', ...dashboardAuth, async (req, res) => {
  const { data } = await supabaseAdmin
    .from('supply_clients')
    .select('*')
    .eq('supplier_id', req.supplier_id)
    .order('name');
  return res.json({ clients: data ?? [] });
});

router.post('/dashboard/:supplierId/clients', ...dashboardAuth, async (req, res) => {
  try {
    const { name, phone, gstin, credit_limit, delivery_days, slug, address } = req.body;
    const normalized = normalizePhone(phone);
    const clientSlug = slug || name.toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    const { data, error } = await supabaseAdmin
      .from('supply_clients')
      .insert({
        supplier_id: req.supplier_id,
        name,
        phone: normalized,
        gstin: gstin ?? null,
        credit_limit: credit_limit ?? 50000,
        delivery_days: delivery_days ?? ['Monday', 'Wednesday', 'Friday'],
        slug: clientSlug,
        address: address ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    return res.status(201).json(data);
  } catch (err) {
    console.error('[supply/clients POST]', err);
    return res.status(500).json({ error: err.message || 'Failed to create client' });
  }
});

router.get('/dashboard/:supplierId/catalog', ...dashboardAuth, async (req, res) => {
  const { data } = await supabaseAdmin
    .from('supply_catalog_items')
    .select('*')
    .eq('supplier_id', req.supplier_id)
    .order('display_order');
  return res.json({ items: data ?? [] });
});

router.post('/dashboard/:supplierId/catalog', ...dashboardAuth, async (req, res) => {
  try {
    const row = { ...req.body, supplier_id: req.supplier_id };
    delete row.id;
    const { data, error } = await supabaseAdmin
      .from('supply_catalog_items')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return res.status(201).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to add catalog item' });
  }
});

router.put('/dashboard/:supplierId/client-prices/:clientId', ...dashboardAuth, async (req, res) => {
  try {
    const prices = req.body.prices ?? [];
    for (const p of prices) {
      await supabaseAdmin.from('supply_client_prices').upsert({
        client_id: req.params.clientId,
        item_id: p.item_id,
        price: p.price,
      });
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update prices' });
  }
});

router.get('/dashboard/:supplierId/orders', ...dashboardAuth, async (req, res) => {
  const { data } = await supabaseAdmin
    .from('supply_orders')
    .select('*, supply_clients(name, phone)')
    .eq('supplier_id', req.supplier_id)
    .order('created_at', { ascending: false })
    .limit(50);
  return res.json({ orders: data ?? [] });
});

router.get('/dashboard/:supplierId/payment-claims', ...dashboardAuth, async (req, res) => {
  const { data } = await supabaseAdmin
    .from('supply_payment_claims')
    .select('*, supply_clients(name, phone)')
    .eq('supplier_id', req.supplier_id)
    .eq('status', 'pending')
    .order('claimed_at', { ascending: false });
  return res.json({ claims: data ?? [] });
});

router.post('/dashboard/:supplierId/payment-claim/:claimId/confirm', ...dashboardAuth, async (req, res) => {
  try {
    const { data: claim } = await supabaseAdmin
      .from('supply_payment_claims')
      .select('*')
      .eq('id', req.params.claimId)
      .eq('supplier_id', req.supplier_id)
      .single();
    if (!claim) return res.status(404).json({ error: 'Claim not found' });

    const amount = Number(req.body.amount ?? claim.claimed_amount ?? 0);
    const prev = await getOutstandingBalance(claim.client_id);
    const balanceAfter = Math.max(0, prev - amount);

    await supabaseAdmin.from('supply_credit_ledger').insert({
      supplier_id: req.supplier_id,
      client_id: claim.client_id,
      type: 'credit',
      amount,
      balance_after: balanceAfter,
      payment_claim_id: claim.id,
      note: 'Payment confirmed',
    });

    await supabaseAdmin
      .from('supply_payment_claims')
      .update({ status: 'confirmed', resolved_at: new Date().toISOString() })
      .eq('id', claim.id);

    return res.json({ new_outstanding: balanceAfter });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

router.post('/dashboard/:supplierId/payment-claim/:claimId/reject', ...dashboardAuth, async (req, res) => {
  await supabaseAdmin
    .from('supply_payment_claims')
    .update({ status: 'rejected', resolved_at: new Date().toISOString() })
    .eq('id', req.params.claimId)
    .eq('supplier_id', req.supplier_id);
  return res.json({ ok: true });
});

router.get('/dashboard/my-suppliers', authenticateToken, async (req, res) => {
  const { data } = await supabaseAdmin
    .from('supply_suppliers')
    .select('id, name, slug, phone')
    .eq('owner_user_id', req.user.sub)
    .eq('is_active', true);
  return res.json({ suppliers: data ?? [] });
});

module.exports = router;
