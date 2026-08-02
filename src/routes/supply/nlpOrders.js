// src/routes/supply/nlpOrders.js
// ============================================================================
// Munafe Supply — WhatsApp NLP order helpers (B2B only)
//
// Mounted under /api/supply/orders via orders.js (no extra server mount).
//
// POST /nlp-preview   — price draft lines via resolvePrice()
// POST /nlp-confirm   — create order (same insert path as form submit)
// POST /nlp-log       — upsert parse/outcome eval rows
//
// Auth: form_token (HMAC), same as public order form submissions.
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin }     = require('../../config/supabase');
const { validateFormToken } = require('./supplyFormToken');
const { resolvePrice }      = require('./ratecards');
const supplyLedger          = require('./ledger');
const { sendSupplyWhatsAppMessage } = require('./supplyWhatsapp');
const { nextSupplyDeliveryDate } = require('../../helpers/istDate');

function _authFromFormToken(form_token) {
  const decoded = validateFormToken(form_token);
  if (!decoded)        return { error: 'Invalid order form token.', status: 401 };
  if (decoded.expired) return { error: 'Order form token has expired.', status: 401 };
  return {
    supplier_id: decoded.supplier_id,
    client_id:   decoded.client_id,
  };
}

function _nextDay(deliveryDays) {
  return nextSupplyDeliveryDate(deliveryDays || [], 'Asia/Kolkata');
}

async function _generateOrderNumber(supplier_id, date) {
  const dateStr = date.replace(/-/g, '');
  const { count } = await supabaseAdmin
    .from('supply_orders')
    .select('id', { count: 'exact', head: true })
    .eq('supplier_id', supplier_id)
    .gte('created_at', `${date}T00:00:00+00:00`)
    .lte('created_at', `${date}T23:59:59+00:00`);
  const seq = String((count || 0) + 1).padStart(3, '0');
  return `ORD-B2B-${dateStr}-${seq}`;
}

// ── POST /nlp-preview ─────────────────────────────────────────────────────────
// Body: { form_token, items: [{ item_id, qty, unit? }] }
router.post('/nlp-preview', async (req, res) => {
  const { form_token, items } = req.body || {};
  const auth = _authFromFormToken(form_token);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required' });
  }

  try {
    const itemIds = items.map(i => i.item_id).filter(Boolean);
    const { data: catalogItems, error: catErr } = await supabaseAdmin
      .from('supply_catalog_items')
      .select('id, name, unit, default_price, gst_rate, min_order_qty, is_available, is_active')
      .eq('supplier_id', auth.supplier_id)
      .in('id', itemIds);

    if (catErr) throw catErr;

    const catalogMap = {};
    (catalogItems || []).forEach(c => { catalogMap[c.id] = c; });

    const lines = [];
    let subtotal = 0;
    let gstTotal = 0;

    for (const li of items) {
      const ci = catalogMap[li.item_id];
      if (!ci || !ci.is_active || !ci.is_available) {
        lines.push({
          item_id: li.item_id,
          error:   'unavailable',
        });
        continue;
      }
      const qty = Number(li.qty);
      if (!(qty > 0)) {
        lines.push({ item_id: li.item_id, error: 'invalid_qty' });
        continue;
      }

      const unitPrice = await resolvePrice(auth.client_id, ci.id, ci.default_price);
      const lineBase  = +(qty * unitPrice).toFixed(2);
      const lineGst   = +(lineBase * (Number(ci.gst_rate) / 100)).toFixed(2);
      const lineTotal = +(lineBase + lineGst).toFixed(2);

      subtotal += lineBase;
      gstTotal += lineGst;

      lines.push({
        item_id:    ci.id,
        name:       ci.name,
        qty,
        unit:       ci.unit,
        unit_price: unitPrice,
        gst_rate:   Number(ci.gst_rate),
        gst_amount: lineGst,
        line_total: lineTotal,
        min_order_qty: Number(ci.min_order_qty) || 0,
      });
    }

    return res.json({
      supplier_id: auth.supplier_id,
      client_id:   auth.client_id,
      lines,
      subtotal:    +subtotal.toFixed(2),
      gst_amount:  +gstTotal.toFixed(2),
      total_amount:+(subtotal + gstTotal).toFixed(2),
    });
  } catch (err) {
    console.error('[supply/nlp-orders] preview', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /nlp-confirm ─────────────────────────────────────────────────────────
// Body: { form_token, items: [{ item_id, qty }], delivery_date?, notes?, draft_id? }
// Mirrors POST /api/supply/orders form path so ledger/status/notifications stay consistent.
router.post('/nlp-confirm', async (req, res) => {
  const { form_token, items, delivery_date, notes, draft_id } = req.body || {};
  const auth = _authFromFormToken(form_token);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const supplier_id = auth.supplier_id;
  const client_id   = auth.client_id;
  const source      = 'whatsapp_nlp';

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must contain at least one item.' });
  }

  const nonZeroItems = items.filter(i => Number(i.qty) > 0);
  if (nonZeroItems.length === 0) {
    return res.status(400).json({ error: 'All item quantities are zero.' });
  }

  try {
    // Soft-lock (same as orders.js)
    try {
      const { isSubscriptionSoftLocked, buildLapsedPayload } = require('../../helpers/subscriptionAccess');
      const { data: sub } = await supabaseAdmin
        .from('supplier_subscriptions')
        .select('status, trial_ends_at, renews_at')
        .eq('supplier_id', supplier_id)
        .maybeSingle();
      if (isSubscriptionSoftLocked(sub)) {
        return res.status(402).json(buildLapsedPayload(sub || {}));
      }
    } catch (gateErr) {
      console.error('[supply/nlp-orders] soft-lock check failed (continuing):', gateErr.message);
    }

    const { data: client, error: clientErr } = await supabaseAdmin
      .from('supply_clients')
      .select('id, name, phone, credit_limit, credit_auto_block, is_active, delivery_days')
      .eq('id', client_id)
      .eq('supplier_id', supplier_id)
      .maybeSingle();

    if (clientErr) return res.status(500).json({ error: clientErr.message });
    if (!client)   return res.status(404).json({ error: 'Client not found.' });
    if (!client.is_active) return res.status(403).json({ error: 'Client account is inactive.' });

    const itemIds = nonZeroItems.map(i => i.item_id);
    const { data: catalogItems, error: catErr } = await supabaseAdmin
      .from('supply_catalog_items')
      .select('id, name, unit, default_price, gst_rate, min_order_qty, is_available, is_active, hsn_code')
      .eq('supplier_id', supplier_id)
      .in('id', itemIds);

    if (catErr) return res.status(500).json({ error: `Catalog validation failed: ${catErr.message}` });

    const catalogMap = {};
    (catalogItems || []).forEach(c => { catalogMap[c.id] = c; });

    const unavailableItems = [];
    const moqErrors = [];
    for (const li of nonZeroItems) {
      const ci = catalogMap[li.item_id];
      if (!ci || !ci.is_active || !ci.is_available) {
        unavailableItems.push(li.item_id);
        continue;
      }
      if (ci.min_order_qty > 0 && Number(li.qty) < Number(ci.min_order_qty)) {
        moqErrors.push({
          item_id: li.item_id,
          name: ci.name,
          min: ci.min_order_qty,
          unit: ci.unit,
        });
      }
    }

    if (unavailableItems.length > 0) {
      return res.status(422).json({
        error: 'Some items are no longer available.',
        code: 'ITEMS_UNAVAILABLE',
        unavailable_ids: unavailableItems,
      });
    }
    if (moqErrors.length > 0) {
      return res.status(422).json({
        error: 'Minimum order quantity not met.',
        code: 'MOQ_VIOLATION',
        violations: moqErrors,
      });
    }

    let orderTotal = 0;
    let gstTotal = 0;
    const orderItems = [];

    for (const li of nonZeroItems) {
      const ci = catalogMap[li.item_id];
      const unitPrice = await resolvePrice(client_id, ci.id, ci.default_price);
      const qty = Number(li.qty);
      const lineBase = +(qty * unitPrice).toFixed(2);
      const lineGst = +(lineBase * (Number(ci.gst_rate) / 100)).toFixed(2);
      const lineTotal = +(lineBase + lineGst).toFixed(2);
      orderTotal += lineTotal;
      gstTotal += lineGst;
      orderItems.push({
        item_id: ci.id,
        item_name: ci.name,
        qty_ordered: qty,
        unit: ci.unit,
        unit_price: unitPrice,
        line_total: lineTotal,
        gst_rate: Number(ci.gst_rate),
        gst_amount: lineGst,
        hsn_code: ci.hsn_code,
      });
    }

    orderTotal = +orderTotal.toFixed(2);
    gstTotal = +gstTotal.toFixed(2);

    const currentBalance = await supplyLedger.getCurrentBalance(client_id);
    const projectedBalance = +(currentBalance + orderTotal).toFixed(2);
    const creditLimit = Number(client.credit_limit);

    if (creditLimit > 0 && client.credit_auto_block && projectedBalance > creditLimit) {
      return res.status(402).json({
        error: 'Order blocked: credit limit reached.',
        code: 'CREDIT_LIMIT_EXCEEDED',
        credit_limit: creditLimit,
        current_balance: currentBalance,
        order_total: orderTotal,
        overage: +(projectedBalance - creditLimit).toFixed(2),
      });
    }

    const delivDate = delivery_date || _nextDay(client.delivery_days);
    const orderNumber = await _generateOrderNumber(supplier_id, delivDate);
    // Client-originated NLP order → same reservation status as webcart form
    const initialStatus = 'requested';

    const { data: newOrder, error: orderErr } = await supabaseAdmin
      .from('supply_orders')
      .insert({
        supplier_id,
        client_id,
        order_number: orderNumber,
        delivery_date: delivDate,
        status: initialStatus,
        total_amount: orderTotal,
        gst_amount: gstTotal,
        delivery_notes: notes || (draft_id ? `nlp_draft:${draft_id}` : null),
        source,
      })
      .select('id, order_number, status, total_amount, gst_amount, delivery_date, created_at')
      .single();

    if (orderErr) {
      console.error('[supply/nlp-orders] Insert order error:', orderErr.message);
      return res.status(500).json({ error: `Failed to create order: ${orderErr.message}` });
    }

    const itemRows = orderItems.map(oi => ({ ...oi, order_id: newOrder.id }));
    const { error: itemsErr } = await supabaseAdmin
      .from('supply_order_items')
      .insert(itemRows);

    if (itemsErr) {
      await supabaseAdmin.from('supply_orders').delete().eq('id', newOrder.id);
      console.error('[supply/nlp-orders] Insert order_items error:', itemsErr.message);
      return res.status(500).json({ error: `Failed to save order items: ${itemsErr.message}` });
    }

    await supabaseAdmin.from('supply_order_status_history').insert({
      order_id: newOrder.id,
      status: initialStatus,
      changed_by: 'client',
    });

    if (client.phone && sendSupplyWhatsAppMessage) {
      const reservationMsg = [
        `Reservation submitted ✅`,
        ``,
        `Order *${newOrder.order_number}* for delivery on ${newOrder.delivery_date}.`,
        `Total: ₹${orderTotal.toFixed(2)}`,
        ``,
        `Your supplier will confirm shortly.`,
      ].join('\n');
      sendSupplyWhatsAppMessage(supplier_id, client.phone, reservationMsg).catch(() => {});
    }

    if (draft_id) {
      await supabaseAdmin
        .from('supply_nlp_order_parse_logs')
        .update({
          outcome: 'confirmed',
          order_id: newOrder.id,
          updated_at: new Date().toISOString(),
        })
        .eq('draft_id', draft_id)
        .eq('supplier_id', supplier_id);
    }

    return res.status(201).json({
      success: true,
      order: newOrder,
      items: orderItems,
    });
  } catch (err) {
    console.error('[supply/nlp-orders] confirm', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /nlp-log ─────────────────────────────────────────────────────────────
// Body: { form_token, draft_id?, raw_text, parsed_output, unmatched, confidence_avg,
//         outcome, phone? }
router.post('/nlp-log', async (req, res) => {
  const {
    form_token,
    draft_id,
    raw_text,
    parsed_output,
    unmatched,
    confidence_avg,
    outcome,
    phone,
    order_id,
  } = req.body || {};

  const auth = _authFromFormToken(form_token);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  try {
    const row = {
      supplier_id: auth.supplier_id,
      client_id: auth.client_id,
      phone: phone || null,
      draft_id: draft_id || null,
      raw_text: raw_text || '',
      parsed_output: parsed_output || {},
      unmatched: unmatched || [],
      confidence_avg: confidence_avg != null ? Number(confidence_avg) : null,
      outcome: outcome || 'parsed',
      order_id: order_id || null,
      updated_at: new Date().toISOString(),
    };

    if (draft_id) {
      const { data: existing } = await supabaseAdmin
        .from('supply_nlp_order_parse_logs')
        .select('id')
        .eq('draft_id', draft_id)
        .eq('supplier_id', auth.supplier_id)
        .maybeSingle();

      if (existing?.id) {
        const { data, error } = await supabaseAdmin
          .from('supply_nlp_order_parse_logs')
          .update(row)
          .eq('id', existing.id)
          .select('id')
          .single();
        if (error) throw error;
        return res.json({ id: data.id, updated: true });
      }
    }

    const { data, error } = await supabaseAdmin
      .from('supply_nlp_order_parse_logs')
      .insert(row)
      .select('id')
      .single();
    if (error) throw error;
    return res.status(201).json({ id: data.id, updated: false });
  } catch (err) {
    // Table may not exist until migration is applied — soft-fail for pilot.
    console.warn('[supply/nlp-orders] log failed:', err.message);
    return res.status(200).json({ logged: false, error: err.message });
  }
});

module.exports = router;
