// src/routes/supply/form.js
// ============================================================================
// MODULE 5 — Order Form (public, token-authenticated)
//
// Routes:
//   GET  /api/supply/form/:token          → validate token, return form payload
//   POST /api/supply/form/generate-link   → supplier generates link for a client
//                                           (requires supplyAuthMiddleware)
//   POST /api/supply/form/mint-link       → internal mint for chat bot
//                                           (AUTOM8_KDS_SECRET / SUPPLY_INTERNAL_SECRET)
//
// The order SUBMISSION (POST /api/supply/orders) is handled in orders.js.
// This file is intentionally public — no JWT. Auth is via HMAC-signed token.
// Buyers are supply_clients (any LOB); catalog comes from the supplier.
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin }                        = require('../../config/supabase');
const { authenticateToken }                    = require('../../middleware/auth');
const { getSupplierContext, requireSupplyRole } = require('../../middleware/supplyAuth');
const opsRoles = requireSupplyRole('owner', 'manager');
const { createFormToken, validateFormToken, renewPermanentToken }
                                               = require('./supplyFormToken');
const supplyLedger                              = require('./ledger');
const { nextSupplyDeliveryDate }                = require('../../helpers/istDate');

const BASE_URL = process.env.SUPPLY_FORM_BASE_URL || 'https://app.autom8.works';

function assertInternalSecret(req, res) {
  const internalSecret = req.headers['x-internal-secret']
    || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const validSecret = process.env.AUTOM8_KDS_SECRET || process.env.SUPPLY_INTERNAL_SECRET;
  if (!validSecret || internalSecret !== validSecret) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

function getTodayCutoffDate(supplier) {
  const cutoff = supplier?.ordering_cutoff_time || '22:00:00';
  const [hours = '22', minutes = '00'] = String(cutoff).split(':');
  const validUntil = new Date();
  validUntil.setHours(Number(hours), Number(minutes), 0, 0);
  if (validUntil.getTime() <= Date.now()) {
    validUntil.setDate(validUntil.getDate() + 1);
  }
  return validUntil;
}

// ── POST /api/supply/form/mint-link ───────────────────────────────────────────
// Internal: chat WhatsApp agent mints a form URL with the same HMAC secret as
// GET /:token validation. Must be registered BEFORE /:token.
// Body: { supplier_id, client_id, permanent?: boolean }

router.post('/mint-link', async (req, res) => {
  if (!assertInternalSecret(req, res)) return;

  const { supplier_id, client_id, permanent = false } = req.body || {};
  if (!supplier_id || !client_id) {
    return res.status(400).json({ error: 'supplier_id and client_id are required' });
  }

  try {
    const { data: client, error: clientErr } = await supabaseAdmin
      .from('supply_clients')
      .select('id, name, is_active')
      .eq('id', client_id)
      .eq('supplier_id', supplier_id)
      .maybeSingle();

    if (clientErr) return res.status(500).json({ error: clientErr.message });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!client.is_active) return res.status(400).json({ error: 'Client is inactive' });

    let valid_until = null;
    if (!permanent) {
      const { data: supplier } = await supabaseAdmin
        .from('suppliers')
        .select('ordering_cutoff_time')
        .eq('id', supplier_id)
        .maybeSingle();
      valid_until = getTodayCutoffDate(supplier);
    }

    const token    = createFormToken(supplier_id, client_id, valid_until, !!permanent);
    const pathBase = permanent ? '/s/b' : '/s';
    const url      = `${BASE_URL.replace(/\/$/, '')}${pathBase}/${token}`;

    return res.json({
      url,
      token,
      supplier_id,
      client_id,
      client_name: client.name,
      permanent: !!permanent,
    });
  } catch (err) {
    console.error('[form] mint-link error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/supply/form/generate-link ──────────────────────────────────────
// Must be registered BEFORE /:token so "generate-link" is never treated as a token.
// Body: { client_id, type: 'daily' | 'permanent' }

router.post('/generate-link', authenticateToken, getSupplierContext, opsRoles, async (req, res) => {
  const { client_id, type = 'daily' } = req.body;
  const supplier_id = req.supplier_id;

  if (!client_id) return res.status(400).json({ error: 'client_id is required' });
  if (!['daily', 'permanent'].includes(type)) {
    return res.status(400).json({ error: "type must be 'daily' or 'permanent'" });
  }

  try {
    const { data: client, error: clientErr } = await supabaseAdmin
      .from('supply_clients')
      .select('id, name, is_active')
      .eq('id', client_id)
      .eq('supplier_id', supplier_id)
      .maybeSingle();

    if (clientErr) return res.status(500).json({ error: clientErr.message });
    if (!client)   return res.status(404).json({ error: 'Client not found' });
    if (!client.is_active) return res.status(400).json({ error: 'Client is inactive' });

    let valid_until = null;
    let permanent   = false;

    if (type === 'permanent') {
      permanent = true;
    } else {
      const { data: supplier } = await supabaseAdmin
        .from('suppliers')
        .select('ordering_cutoff_time, timezone')
        .eq('id', supplier_id)
        .maybeSingle();

      const tz      = supplier?.timezone || 'Asia/Kolkata';
      const [cutH, cutM] = (supplier?.ordering_cutoff_time || '22:00').split(':').map(Number);
      const nowIST  = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
      nowIST.setHours(cutH, cutM, 0, 0);
      valid_until = nowIST;
    }

    const token    = createFormToken(supplier_id, client_id, valid_until, permanent);
    const pathBase = permanent ? '/s/b' : '/s';
    const url      = `${BASE_URL}${pathBase}/${token}`;

    return res.json({
      url,
      token,
      client_id,
      client_name: client.name,
      type,
    });
  } catch (err) {
    console.error('[form] generate-link error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/supply/form/:token ───────────────────────────────────────────────
// Public. Called by OrderForm.jsx on mount.
// Returns: supplier header, buyer profile + credit balance, today's catalog grouped by category.

router.get('/:token', async (req, res) => {
  const { token }  = req.params;
  const { prefill } = req.query;  // 'last' → pre-fill last order quantities

  // 1. Validate token
  const decoded = validateFormToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid order link. Please request a new link from your supplier.' });
  }

  if (decoded.expired) {
    return res.status(410).json({
      error:   'This order link has expired.',
      code:    'TOKEN_EXPIRED',
      message: 'Your daily order link is valid only during the ordering window. Contact your supplier for a new link.',
    });
  }

  const { supplier_id, client_id, permanent } = decoded;

  try {
    // 2. Fetch supplier profile
    const { data: supplier, error: supErr } = await supabaseAdmin
      .from('suppliers')
      .select('id, business_name, logo_url, ordering_open_time, ordering_cutoff_time, always_open, timezone')
      .eq('id', supplier_id)
      .maybeSingle();

    if (supErr) {
      console.error('[form] Supplier fetch error:', supErr.message);
      return res.status(500).json({ error: 'Unable to load order form. Please try again.' });
    }
    if (!supplier) return res.status(404).json({ error: 'Supplier account not found.' });

    // 3. Check ordering window (only for daily tokens; permanent tokens bypass)
    if (!supplier.always_open && !permanent) {
      const tz    = supplier.timezone || 'Asia/Kolkata';
      const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
      const [openH, openM] = supplier.ordering_open_time.split(':').map(Number);
      const [cutH,  cutM]  = supplier.ordering_cutoff_time.split(':').map(Number);
      const nowMins  = nowIST.getHours() * 60 + nowIST.getMinutes();
      const openMins = openH * 60 + openM;
      const cutMins  = cutH  * 60 + cutM;

      if (nowMins < openMins || nowMins >= cutMins) {
        return res.status(423).json({
          error:                'Ordering is currently closed.',
          code:                 'ORDERING_CLOSED',
          ordering_open_time:   supplier.ordering_open_time,
          ordering_cutoff_time: supplier.ordering_cutoff_time,
          timezone:             tz,
          message:              `Orders can be placed between ${supplier.ordering_open_time} and ${supplier.ordering_cutoff_time} IST.`,
        });
      }
    }

    // 4. Fetch client profile
    const { data: client, error: clientErr } = await supabaseAdmin
      .from('supply_clients')
      .select('id, name, phone, credit_limit, credit_terms_days, credit_auto_block, delivery_days, is_active')
      .eq('id', client_id)
      .eq('supplier_id', supplier_id)
      .maybeSingle();

    if (clientErr) {
      console.error('[form] Client fetch error:', clientErr.message);
      return res.status(500).json({ error: 'Unable to load client profile.' });
    }
    if (!client)          return res.status(404).json({ error: 'Client not found.' });
    if (!client.is_active) return res.status(403).json({ error: 'Your account has been deactivated. Please contact your supplier.' });

    // 5. Fetch today's available catalog items for this supplier
    const { data: items, error: itemErr } = await supabaseAdmin
      .from('supply_catalog_items')
      .select('id, name, category, unit, unit_type, default_price, gst_rate, min_order_qty, display_order, hsn_code')
      .eq('supplier_id', supplier_id)
      .eq('is_available', true)
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('display_order', { ascending: true })
      .order('name', { ascending: true });

    if (itemErr) {
      console.error('[form] Catalog fetch error:', itemErr.message);
      return res.status(500).json({ error: 'Unable to load catalog.' });
    }

    // 6. Fetch client-specific price overrides (Module 4 price resolution)
    const itemIds = (items || []).map(i => i.id);
    let priceOverrides = {};

    if (itemIds.length > 0) {
      const { data: prices } = await supabaseAdmin
        .from('supply_client_prices')
        .select('item_id, price')
        .eq('client_id', client_id)
        .in('item_id', itemIds);

      (prices || []).forEach(p => { priceOverrides[p.item_id] = Number(p.price); });
    }

    // Resolve price: client override > catalog default
    const resolvedItems = (items || []).map(item => ({
      id:            item.id,
      name:          item.name,
      category:      item.category,
      unit:          item.unit,
      unit_type:     item.unit_type || 'weight',
      price:         priceOverrides[item.id] !== undefined
                       ? priceOverrides[item.id]
                       : Number(item.default_price),
      gst_rate:      Number(item.gst_rate),
      min_order_qty: Number(item.min_order_qty),
      display_order: item.display_order,
      hsn_code:      item.hsn_code,
    }));

    // Group items by category (maintains display_order sort within each)
    const categoriesMap = {};
    resolvedItems.forEach(item => {
      if (!categoriesMap[item.category]) categoriesMap[item.category] = [];
      categoriesMap[item.category].push(item);
    });

    // 7. Credit balance
    const currentBalance = await supplyLedger.getCurrentBalance(client_id);
    const creditAvailable = client.credit_limit === -1
      ? null  // unlimited
      : Math.max(0, client.credit_limit - currentBalance);

    // 8. Pre-fill last order quantities if requested
    let lastOrderQtys = null;
    if (prefill === 'last') {
      const { data: lastOrder } = await supabaseAdmin
        .from('supply_orders')
        .select('id')
        .eq('client_id', client_id)
        .eq('supplier_id', supplier_id)
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastOrder) {
        const { data: lastItems } = await supabaseAdmin
          .from('supply_order_items')
          .select('item_id, qty_ordered')
          .eq('order_id', lastOrder.id);

        if (lastItems) {
          lastOrderQtys = {};
          lastItems.forEach(li => { lastOrderQtys[li.item_id] = Number(li.qty_ordered); });
        }
      }
    }

    // 9. Next delivery date based on client delivery days (IST calendar)
    const nextDeliveryDate = _nextDeliveryDate(client.delivery_days);

    // 10. Renew permanent token if close to expiry
    let renewedToken = null;
    if (permanent) {
      renewedToken = renewPermanentToken(decoded);
    }

    return res.json({
      supplier: {
        id:                   supplier.id,
        business_name:        supplier.business_name,
        logo_url:             supplier.logo_url,
        ordering_cutoff_time: supplier.ordering_cutoff_time,
        timezone:             supplier.timezone || 'Asia/Kolkata',
      },
      client: {
        id:               client.id,
        name:             client.name,
        credit_limit:     Number(client.credit_limit),
        credit_auto_block: client.credit_auto_block,
        current_balance:  currentBalance,
        credit_available: creditAvailable,
      },
      delivery_date:    nextDeliveryDate,
      categories:       categoriesMap,
      item_count:       resolvedItems.length,
      last_order_qtys:  lastOrderQtys,
      renewed_token:    renewedToken,   // non-null when permanent token was refreshed
    });

  } catch (err) {
    console.error('[form] Unexpected error in GET /:token:', err.message);
    return res.status(500).json({ error: `Order form failed to load: ${err.message}` });
  }
});

function _nextDeliveryDate(deliveryDays = []) {
  return nextSupplyDeliveryDate(deliveryDays, 'Asia/Kolkata');
}

module.exports = router;
