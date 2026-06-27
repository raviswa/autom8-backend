// src/routes/supply/orders.js
// ============================================================================
// MODULE 6 — Order Management
//
// Public route (form token auth):
//   POST /api/supply/orders              — client submits order via form
//
// Supplier routes (supplyAuthMiddleware):
//   GET  /api/supply/orders              — list orders (filter: date, status, client)
//   GET  /api/supply/orders/picking-list/:date   — aggregated picking list
//   GET  /api/supply/orders/route-sheet/:date    — delivery route sheet
//   GET  /api/supply/orders/:id          — single order detail
//   PUT  /api/supply/orders/:id/status   — update status
//   PUT  /api/supply/orders/:id/partial-delivery — record delivered quantities
//   POST /api/supply/orders/:id/cancel   — cancel order
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin }          = require('../../config/supabase');
const { supplyAuthMiddleware }   = require('../../middleware/supplyAuth');
const { validateFormToken }      = require('./supplyFormToken');
const supplyLedger               = require('./ledger');
const { notifyClient }           = require('./notify');

const VALID_STATUSES = ['confirmed', 'out_for_delivery', 'delivered', 'partially_delivered', 'cancelled'];

// ============================================================================
// POST /api/supply/orders  — create order
// ============================================================================
// Accepts TWO auth modes:
//   A) form_token in body  → submitted by client via OrderForm.jsx (no JWT)
//   B) Bearer JWT          → supplier manually creates order from dashboard
//
// Body (mode A):
//   { form_token, items: [{ item_id, qty }], delivery_date?, notes? }
//
// Body (mode B):
//   { client_id, items: [...], delivery_date?, notes? }
//   + Authorization: Bearer <supply_jwt>
// ============================================================================

router.post('/', async (req, res) => {
  const { form_token, client_id: bodyClientId, items, delivery_date, notes } = req.body;

  let supplier_id, client_id, source;

  // ── Determine auth mode ───────────────────────────────────────────────────
  if (form_token) {
    // Mode A: form submission
    const decoded = validateFormToken(form_token);
    if (!decoded)         return res.status(401).json({ error: 'Invalid order form token.' });
    if (decoded.expired)  return res.status(401).json({ error: 'Order form token has expired. Please request a new link.' });
    supplier_id = decoded.supplier_id;
    client_id   = decoded.client_id;
    source      = 'form';
  } else {
    // Mode B: supplier manual entry — validate JWT inline
    const authHeader = req.headers['authorization'];
    const token      = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Authentication required.' });

    const jwt    = require('jsonwebtoken');
    const SECRET = process.env.SUPPLY_JWT_SECRET || 'dev_supply_secret';
    let payload;
    try {
      payload = jwt.verify(token, SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired supplier token.' });
    }
    if (payload.role !== 'supplier') return res.status(403).json({ error: 'Not a supplier token.' });

    supplier_id = payload.supplier_id;
    client_id   = bodyClientId;
    source      = 'manual';
    if (!client_id) return res.status(400).json({ error: 'client_id is required for manual orders.' });
  }

  // ── Validate items ────────────────────────────────────────────────────────
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must contain at least one item.' });
  }

  const nonZeroItems = items.filter(i => Number(i.qty) > 0);
  if (nonZeroItems.length === 0) {
    return res.status(400).json({ error: 'All item quantities are zero. Please enter at least one quantity.' });
  }

  try {
    // ── Fetch client ──────────────────────────────────────────────────────
    const { data: client, error: clientErr } = await supabaseAdmin
      .from('supply_clients')
      .select('id, name, phone, credit_limit, credit_auto_block, is_active')
      .eq('id', client_id)
      .eq('supplier_id', supplier_id)
      .maybeSingle();

    const { data: supplier } = await supabaseAdmin
      .from('suppliers')
      .select('phone')
      .eq('id', supplier_id)
      .maybeSingle();

    if (clientErr) return res.status(500).json({ error: clientErr.message });
    if (!client)   return res.status(404).json({ error: 'Client not found.' });
    if (!client.is_active) return res.status(403).json({ error: 'Client account is inactive.' });

    // ── Fetch + validate catalog items ────────────────────────────────────
    const itemIds = nonZeroItems.map(i => i.item_id);

    const { data: catalogItems, error: catErr } = await supabaseAdmin
      .from('supply_catalog_items')
      .select('id, name, unit, default_price, gst_rate, min_order_qty, is_available, is_active, hsn_code')
      .eq('supplier_id', supplier_id)
      .in('id', itemIds);

    if (catErr) return res.status(500).json({ error: `Catalog validation failed: ${catErr.message}` });

    const catalogMap = {};
    (catalogItems || []).forEach(c => { catalogMap[c.id] = c; });

    // Check all items exist, are active and available
    const unavailableItems = [];
    const moqErrors        = [];

    for (const li of nonZeroItems) {
      const ci = catalogMap[li.item_id];
      if (!ci || !ci.is_active)     { unavailableItems.push(li.item_id); continue; }
      if (!ci.is_available)          { unavailableItems.push(li.item_id); continue; }
      if (ci.min_order_qty > 0 && Number(li.qty) < Number(ci.min_order_qty)) {
        moqErrors.push({ item_id: li.item_id, name: ci.name, min: ci.min_order_qty, unit: ci.unit });
      }
    }

    if (unavailableItems.length > 0) {
      return res.status(422).json({
        error:            'Some items are no longer available.',
        code:             'ITEMS_UNAVAILABLE',
        unavailable_ids:  unavailableItems,
      });
    }

    if (moqErrors.length > 0) {
      return res.status(422).json({
        error:      'Minimum order quantity not met.',
        code:       'MOQ_VIOLATION',
        violations: moqErrors,
      });
    }

    // ── Fetch client price overrides ──────────────────────────────────────
    const { data: priceRows } = await supabaseAdmin
      .from('supply_client_prices')
      .select('item_id, price')
      .eq('client_id', client_id)
      .in('item_id', itemIds);

    const priceOverrides = {};
    (priceRows || []).forEach(p => { priceOverrides[p.item_id] = Number(p.price); });

    // ── Build order items + calculate totals ──────────────────────────────
    let orderTotal = 0;
    let gstTotal   = 0;

    const orderItems = nonZeroItems.map(li => {
      const ci         = catalogMap[li.item_id];
      const unitPrice  = priceOverrides[li.item_id] !== undefined
                           ? priceOverrides[li.item_id]
                           : Number(ci.default_price);
      const qty        = Number(li.qty);
      const lineBase   = +(qty * unitPrice).toFixed(2);
      const lineGst    = +(lineBase * (Number(ci.gst_rate) / 100)).toFixed(2);
      const lineTotal  = +(lineBase + lineGst).toFixed(2);

      orderTotal += lineTotal;
      gstTotal   += lineGst;

      return {
        item_id:     li.item_id,
        item_name:   ci.name,
        qty_ordered: qty,
        unit:        ci.unit,
        unit_price:  unitPrice,
        line_total:  lineTotal,
        gst_rate:    Number(ci.gst_rate),
        gst_amount:  lineGst,
        hsn_code:    ci.hsn_code,
      };
    });

    orderTotal = +orderTotal.toFixed(2);
    gstTotal   = +gstTotal.toFixed(2);

    // ── Credit check ──────────────────────────────────────────────────────
    const currentBalance   = await supplyLedger.getCurrentBalance(client_id);
    const projectedBalance = +(currentBalance + orderTotal).toFixed(2);
    const creditLimit      = Number(client.credit_limit);

    if (creditLimit > 0 && client.credit_auto_block && projectedBalance > creditLimit) {
      return res.status(402).json({
        error:            'Order blocked: credit limit reached.',
        code:             'CREDIT_LIMIT_EXCEEDED',
        credit_limit:     creditLimit,
        current_balance:  currentBalance,
        order_total:      orderTotal,
        overage:          +(projectedBalance - creditLimit).toFixed(2),
      });
    }

    // ── Generate order number ─────────────────────────────────────────────
    const delivDate   = delivery_date || _nextDay();
    const orderNumber = await _generateOrderNumber(supplier_id, delivDate);

    // ── Insert supply_orders ──────────────────────────────────────────────
    const { data: newOrder, error: orderErr } = await supabaseAdmin
      .from('supply_orders')
      .insert({
        supplier_id,
        client_id,
        order_number:   orderNumber,
        delivery_date:  delivDate,
        status:         'confirmed',
        total_amount:   orderTotal,
        gst_amount:     gstTotal,
        delivery_notes: notes || null,
        source,
      })
      .select('id, order_number, status, total_amount, gst_amount, delivery_date, created_at')
      .single();

    if (orderErr) {
      console.error('[orders] Insert order error:', orderErr.message);
      return res.status(500).json({ error: `Failed to create order: ${orderErr.message}` });
    }

    // ── Insert supply_order_items ─────────────────────────────────────────
    const itemRows = orderItems.map(oi => ({ ...oi, order_id: newOrder.id }));

    const { error: itemsErr } = await supabaseAdmin
      .from('supply_order_items')
      .insert(itemRows);

    if (itemsErr) {
      // Rollback: delete the order we just created
      await supabaseAdmin.from('supply_orders').delete().eq('id', newOrder.id);
      console.error('[orders] Insert order_items error:', itemsErr.message);
      return res.status(500).json({ error: `Failed to save order items: ${itemsErr.message}` });
    }

    // ── Insert initial status history ─────────────────────────────────────
    await supabaseAdmin.from('supply_order_status_history').insert({
      order_id:   newOrder.id,
      status:     'confirmed',
      changed_by: source === 'manual' ? 'supplier' : 'system',
    });

    // ── Create ledger debit ───────────────────────────────────────────────
    await supplyLedger.createDebit(supplier_id, client_id, newOrder.id, orderTotal, 'Order placed');

    // ── Notifications ─────────────────────────────────────────────────────
    const notifyPromises = [];
    notifyPromises.push(notifyClient(supplier_id, client.phone, 'supply_order_confirmed', {
      order_number:  newOrder.order_number,
      delivery_date: newOrder.delivery_date,
      total_amount:  orderTotal,
    }, client_id));

    if (supplier?.phone) {
      notifyPromises.push(notifyClient(supplier_id, supplier.phone, 'supply_new_order_alert', {
        client_name:  client.name,
        order_number: newOrder.order_number,
        total_amount: orderTotal,
      }, client_id));
    }

    Promise.allSettled(notifyPromises).catch(err => {
      console.error('[orders] notification error:', err.message || err);
    });

    return res.status(201).json({
      success:     true,
      order:       newOrder,
      items:       orderItems,
      order_total: orderTotal,
      gst_total:   gstTotal,
      new_balance: +(currentBalance + orderTotal).toFixed(2),
    });

  } catch (err) {
    console.error('[orders] POST / unexpected error:', err.message);
    return res.status(500).json({ error: `Order creation failed: ${err.message}` });
  }
});

// ============================================================================
// GET /api/supply/orders/picking-list/:date
// ⚠️  Must be defined BEFORE GET /:id to avoid route shadowing
// ============================================================================
// Aggregated picking list: all confirmed+out_for_delivery orders for a date,
// grouped by item — shows total qty needed and per-client breakdown.

router.get('/picking-list/:date', supplyAuthMiddleware, async (req, res) => {
  const { date }    = req.params;
  const supplier_id = req.supplier_id;

  if (!_isValidDate(date)) return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });

  try {
    const { data: orders, error: ordErr } = await supabaseAdmin
      .from('supply_orders')
      .select(`
        id, order_number, client_id, status,
        supply_clients ( id, name, address, city, pincode ),
        supply_order_items (
          item_id, item_name, qty_ordered, unit, unit_price, gst_rate
        )
      `)
      .eq('supplier_id', supplier_id)
      .eq('delivery_date', date)
      .in('status', ['confirmed', 'out_for_delivery']);

    if (ordErr) return res.status(500).json({ error: ordErr.message });
    if (!orders || orders.length === 0) {
      return res.json({ date, orders: [], picking_list: [], total_clients: 0 });
    }

    // Aggregate by item
    const itemAgg = {};  // item_id → { item_name, unit, total_qty, clients: [] }

    orders.forEach(order => {
      const clientName = order.supply_clients?.name || 'Unknown';
      (order.supply_order_items || []).forEach(oi => {
        if (!itemAgg[oi.item_id]) {
          itemAgg[oi.item_id] = {
            item_id:   oi.item_id,
            item_name: oi.item_name,
            unit:      oi.unit,
            total_qty: 0,
            clients:   [],
          };
        }
        itemAgg[oi.item_id].total_qty = +(itemAgg[oi.item_id].total_qty + Number(oi.qty_ordered)).toFixed(3);
        itemAgg[oi.item_id].clients.push({
          client_id:    order.client_id,
          client_name:  clientName,
          qty:          Number(oi.qty_ordered),
          order_id:     order.id,
          order_number: order.order_number,
        });
      });
    });

    const pickingList = Object.values(itemAgg)
      .sort((a, b) => a.item_name.localeCompare(b.item_name));

    return res.json({
      date,
      total_orders:  orders.length,
      total_clients: new Set(orders.map(o => o.client_id)).size,
      picking_list:  pickingList,
    });

  } catch (err) {
    console.error('[orders] picking-list error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/supply/orders/route-sheet/:date
// Delivery route: orders grouped by pincode, sorted by client name
// ============================================================================

router.get('/route-sheet/:date', supplyAuthMiddleware, async (req, res) => {
  const { date }    = req.params;
  const supplier_id = req.supplier_id;

  if (!_isValidDate(date)) return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });

  try {
    const { data: orders, error: ordErr } = await supabaseAdmin
      .from('supply_orders')
      .select(`
        id, order_number, status, total_amount,
        supply_clients ( id, name, phone, address, city, pincode ),
        supply_order_items ( item_name, qty_ordered, unit, line_total )
      `)
      .eq('supplier_id', supplier_id)
      .eq('delivery_date', date)
      .in('status', ['confirmed', 'out_for_delivery']);

    if (ordErr) return res.status(500).json({ error: ordErr.message });
    if (!orders || orders.length === 0) {
      return res.json({ date, route: [], total_stops: 0 });
    }

    // Group by pincode
    const pincodeMap = {};

    orders.forEach(order => {
      const pin = order.supply_clients?.pincode || 'Unknown';
      if (!pincodeMap[pin]) pincodeMap[pin] = [];
      pincodeMap[pin].push({
        order_id:     order.id,
        order_number: order.order_number,
        status:       order.status,
        total_amount: Number(order.total_amount),
        client: {
          id:      order.supply_clients?.id,
          name:    order.supply_clients?.name,
          phone:   order.supply_clients?.phone,
          address: order.supply_clients?.address,
          city:    order.supply_clients?.city,
          pincode: order.supply_clients?.pincode,
        },
        items: (order.supply_order_items || []).map(oi => ({
          name:  oi.item_name,
          qty:   Number(oi.qty_ordered),
          unit:  oi.unit,
          total: Number(oi.line_total),
        })),
      });
    });

    // Sort within each pincode by client name
    const route = Object.entries(pincodeMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([pincode, stops]) => ({
        pincode,
        stops: stops.sort((a, b) => a.client.name.localeCompare(b.client.name)),
      }));

    return res.json({
      date,
      total_stops: orders.length,
      route,
    });

  } catch (err) {
    console.error('[orders] route-sheet error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/supply/orders  — list orders with filters
// ============================================================================

router.get('/', supplyAuthMiddleware, async (req, res) => {
  const supplier_id = req.supplier_id;
  const {
    date,
    status,
    client_id,
    page  = 1,
    limit = 50,
  } = req.query;

  try {
    let query = supabaseAdmin
      .from('supply_orders')
      .select(`
        id, order_number, delivery_date, status, total_amount, gst_amount, source, created_at,
        supply_clients ( id, name, phone )
      `, { count: 'exact' })
      .eq('supplier_id', supplier_id)
      .order('created_at', { ascending: false })
      .range((Number(page) - 1) * Number(limit), Number(page) * Number(limit) - 1);

    if (date)      query = query.eq('delivery_date', date);
    if (status)    query = query.eq('status', status);
    if (client_id) query = query.eq('client_id', client_id);

    const { data: orders, count, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    return res.json({
      orders: orders || [],
      total:  count,
      page:   Number(page),
      limit:  Number(limit),
      pages:  Math.ceil(count / Number(limit)),
    });

  } catch (err) {
    console.error('[orders] GET / error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/supply/orders/:id  — single order detail
// ============================================================================

router.get('/:id', supplyAuthMiddleware, async (req, res) => {
  const { id }      = req.params;
  const supplier_id = req.supplier_id;

  try {
    const { data: order, error } = await supabaseAdmin
      .from('supply_orders')
      .select(`
        *,
        supply_clients ( id, name, phone, address, city, pincode, gstin, credit_limit, credit_terms_days ),
        supply_order_items ( * ),
        supply_order_status_history ( status, changed_at, changed_by )
      `)
      .eq('id', id)
      .eq('supplier_id', supplier_id)
      .maybeSingle();

    if (error)  return res.status(500).json({ error: error.message });
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    // Append credit impact
    const currentBalance = await supplyLedger.getCurrentBalance(order.client_id);

    return res.json({
      ...order,
      client_balance: currentBalance,
    });

  } catch (err) {
    console.error('[orders] GET /:id error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PUT /api/supply/orders/:id/status  — update order status
// Body: { status: 'out_for_delivery' | 'delivered' | 'partially_delivered' }
// ============================================================================

router.put('/:id/status', supplyAuthMiddleware, async (req, res) => {
  const { id }      = req.params;
  const { status }  = req.body;
  const supplier_id = req.supplier_id;

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Valid values: ${VALID_STATUSES.join(', ')}` });
  }
  if (status === 'cancelled') {
    return res.status(400).json({ error: 'Use POST /:id/cancel to cancel an order.' });
  }

  try {
    // Include delivery_date + client phone so we can notify without a second query
    const { data: order, error: fetchErr } = await supabaseAdmin
      .from('supply_orders')
      .select('id, status, client_id, total_amount, delivery_date, supply_clients(phone)')
      .eq('id', id)
      .eq('supplier_id', supplier_id)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!order)   return res.status(404).json({ error: 'Order not found.' });
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot update a cancelled order.' });
    }

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('supply_orders')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, order_number, status, updated_at')
      .single();

    if (updErr) return res.status(500).json({ error: updErr.message });

    // Log status history
    await supabaseAdmin.from('supply_order_status_history').insert({
      order_id:   id,
      status,
      changed_by: 'supplier',
    });

    // Notify client on dispatch / delivery
    const statusTemplateMap = {
      out_for_delivery: 'supply_out_for_delivery',
      delivered:        'supply_delivered',
    };
    const tmpl = statusTemplateMap[status];
    if (tmpl && order.supply_clients?.phone) {
      notifyClient(supplier_id, order.supply_clients.phone, tmpl, {
        order_number:  updated.order_number,
        delivery_date: order.delivery_date,
      }, order.client_id).catch(() => {});
    }

    // TODO: Module 9 — if status is 'delivered' or 'partially_delivered', trigger invoice generation

    return res.json({ success: true, order: updated });

  } catch (err) {
    console.error('[orders] PUT /:id/status error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PUT /api/supply/orders/:id/partial-delivery
// Body: { items: [{ item_id, delivered_qty }] }
// Records actual delivered quantities; calculates final totals.
// ============================================================================

router.put('/:id/partial-delivery', supplyAuthMiddleware, async (req, res) => {
  const { id }      = req.params;
  const { items }   = req.body;
  const supplier_id = req.supplier_id;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required.' });
  }

  try {
    // Include client phone so we can notify without a second query
    const { data: order, error: fetchErr } = await supabaseAdmin
      .from('supply_orders')
      .select('id, status, client_id, total_amount, supply_clients(phone)')
      .eq('id', id)
      .eq('supplier_id', supplier_id)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!order)   return res.status(404).json({ error: 'Order not found.' });
    if (['delivered', 'partially_delivered', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ error: `Cannot update delivery for a ${order.status} order.` });
    }

    // Fetch existing order items
    const { data: orderItems } = await supabaseAdmin
      .from('supply_order_items')
      .select('id, item_id, qty_ordered, unit_price, gst_rate')
      .eq('order_id', id);

    const itemMap = {};
    (orderItems || []).forEach(oi => { itemMap[oi.item_id] = oi; });

    // Build delivery map from request
    const deliveryMap = {};
    items.forEach(i => { deliveryMap[i.item_id] = Number(i.delivered_qty); });

    let newTotal   = 0;
    let newGst     = 0;
    let hasPartial = false;

    // Update each order item with delivered qty
    for (const oi of orderItems || []) {
      const deliveredQty = deliveryMap[oi.item_id] !== undefined
        ? deliveryMap[oi.item_id]
        : Number(oi.qty_ordered); // default: fully delivered

      if (deliveredQty < Number(oi.qty_ordered)) hasPartial = true;

      const lineBase  = +(deliveredQty * Number(oi.unit_price)).toFixed(2);
      const lineGst   = +(lineBase * (Number(oi.gst_rate) / 100)).toFixed(2);
      const lineTotal = +(lineBase + lineGst).toFixed(2);

      newTotal += lineTotal;
      newGst   += lineGst;

      await supabaseAdmin
        .from('supply_order_items')
        .update({ qty_delivered: deliveredQty, line_total: lineTotal, gst_amount: lineGst })
        .eq('id', oi.id);
    }

    newTotal = +newTotal.toFixed(2);
    newGst   = +newGst.toFixed(2);

    const finalStatus = hasPartial ? 'partially_delivered' : 'delivered';

    const { data: updated } = await supabaseAdmin
      .from('supply_orders')
      .update({
        status:       finalStatus,
        total_amount: newTotal,
        gst_amount:   newGst,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, order_number, status, total_amount, gst_amount')
      .single();

    await supabaseAdmin.from('supply_order_status_history').insert({
      order_id:   id,
      status:     finalStatus,
      changed_by: 'supplier',
    });

    // Adjust ledger if total changed due to partial quantities
    if (newTotal !== Number(order.total_amount)) {
      await supplyLedger.adjustDebit(id, order.client_id, supplier_id, Number(order.total_amount), newTotal);
    }

    // Notify client on full delivery
    if (finalStatus === 'delivered' && order.supply_clients?.phone) {
      notifyClient(supplier_id, order.supply_clients.phone, 'supply_delivered', {
        order_number: updated.order_number,
      }, order.client_id).catch(() => {});
    }

    // TODO: Module 9 — trigger invoice generation for delivered / partially_delivered

    return res.json({ success: true, order: updated });

  } catch (err) {
    console.error('[orders] PUT /:id/partial-delivery error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/supply/orders/:id/cancel
// ============================================================================

router.post('/:id/cancel', supplyAuthMiddleware, async (req, res) => {
  const { id }      = req.params;
  const { reason }  = req.body;
  const supplier_id = req.supplier_id;

  try {
    // Include order_number + client phone — needed for ledger reversal and notify
    const { data: order, error: fetchErr } = await supabaseAdmin
      .from('supply_orders')
      .select('id, status, client_id, total_amount, order_number, supply_clients(phone)')
      .eq('id', id)
      .eq('supplier_id', supplier_id)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!order)   return res.status(404).json({ error: 'Order not found.' });
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Order is already cancelled.' });
    }
    if (['delivered', 'partially_delivered'].includes(order.status)) {
      return res.status(400).json({ error: 'Cannot cancel a delivered order.' });
    }

    await supabaseAdmin
      .from('supply_orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', id);

    await supabaseAdmin.from('supply_order_status_history').insert({
      order_id:   id,
      status:     'cancelled',
      changed_by: 'supplier',
    });

    // Reverse ledger debit
    await supplyLedger.reverseDebit(id, order.client_id, supplier_id, Number(order.total_amount));

    // Notify client of cancellation
    if (order.supply_clients?.phone) {
      notifyClient(supplier_id, order.supply_clients.phone, 'supply_order_cancelled', {
        order_number: order.order_number,
        reason:       reason || null,
      }, order.client_id).catch(() => {});
    }

    return res.json({ success: true, message: 'Order cancelled.', order_id: id });

  } catch (err) {
    console.error('[orders] POST /:id/cancel error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Internal helpers
// ============================================================================

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

function _isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(Date.parse(str));
}

function _nextDay() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

module.exports = router;