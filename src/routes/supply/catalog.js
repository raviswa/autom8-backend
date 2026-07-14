// src/routes/supply/catalog.js
// ============================================================================
// Munafe Supply — Module 3: Catalog Management
//
// GET    /api/supply/catalog                   — All items for supplier
// POST   /api/supply/catalog                   — Add catalog item
// PUT    /api/supply/catalog/bulk-availability — Bulk toggle availability
// GET    /api/supply/catalog/available-today   — Items where is_available=true
// PUT    /api/supply/catalog/:id               — Edit catalog item
// DELETE /api/supply/catalog/:id               — Soft delete
//
// All routes require Bearer JWT (supply JWT, not Supabase).
// Middleware attaches req.supplier_id from verified token.
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin }     = require('../../config/supabase');
const { supplyAuthMiddleware } = require('../../middleware/supplyAuth');

// ── Category → default GST rate mapping ──────────────────────────────────────
const GST_DEFAULTS = {
  'Vegetables':      0,
  'Fruits':          0,
  'Dairy':           0,   // per-item override for butter/ghee/cheese → 5
  'Eggs & Poultry':  0,
  'Meat & Seafood':  0,
  'Dry Goods':       0,
  'Oils & Fats':     5,
  'Spices':          5,
  'Packaging':       18,
  'Other':           5,
};

const VALID_CATEGORIES = Object.keys(GST_DEFAULTS);

const VALID_UNITS = [
  'kg', 'g', 'litre', 'ml', 'dozen', 'piece', 'bunch', 'bag', 'crate', 'sack',
];

const VALID_UNIT_TYPES = ['count', 'weight', 'volume'];

function defaultUnitType(unit) {
  if (['piece', 'dozen', 'bunch'].includes(unit)) return 'count';
  if (['litre', 'ml'].includes(unit)) return 'volume';
  return 'weight';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function validateItem(body) {
  const errors = [];
  if (!body.name?.trim())                        errors.push('name is required');
  if (!VALID_CATEGORIES.includes(body.category)) errors.push(`category must be one of: ${VALID_CATEGORIES.join(', ')}`);
  if (!VALID_UNITS.includes(body.unit))          errors.push(`unit must be one of: ${VALID_UNITS.join(', ')}`);
  if (body.unit_type != null && !VALID_UNIT_TYPES.includes(body.unit_type))
    errors.push(`unit_type must be one of: ${VALID_UNIT_TYPES.join(', ')}`);
  if (body.default_price == null || isNaN(Number(body.default_price)) || Number(body.default_price) < 0)
    errors.push('default_price must be a non-negative number');
  return errors;
}

// ── GET /api/supply/catalog ───────────────────────────────────────────────────
// Returns all active catalog items for the supplier, grouped by category,
// sorted by display_order then name.
router.get('/', supplyAuthMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('supply_catalog_items')
      .select('*')
      .eq('supplier_id', req.supplier_id)
      .eq('is_active', true)
      .order('category',      { ascending: true })
      .order('display_order', { ascending: true })
      .order('name',          { ascending: true });

    if (error) throw error;
    res.json({ items: data ?? [] });
  } catch (err) {
    console.error('[supply/catalog] GET /', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/supply/catalog/available-today ───────────────────────────────────
// Items visible on the order form today. Used by Module 5 (order form).
router.get('/available-today', supplyAuthMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('supply_catalog_items')
      .select('id, name, category, unit, unit_type, default_price, gst_rate, min_order_qty, display_order')
      .eq('supplier_id', req.supplier_id)
      .eq('is_active', true)
      .eq('is_available', true)
      .order('category',      { ascending: true })
      .order('display_order', { ascending: true })
      .order('name',          { ascending: true });

    if (error) throw error;
    res.json({ items: data ?? [] });
  } catch (err) {
    console.error('[supply/catalog] GET /available-today', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/supply/catalog ──────────────────────────────────────────────────
router.post('/', supplyAuthMiddleware, async (req, res) => {
  try {
    const {
      name, category, unit, unit_type, default_price,
      hsn_code, gst_rate, min_order_qty, display_order,
      is_available = true,
    } = req.body;

    const errors = validateItem(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    // Use category GST default if gst_rate not supplied
    const resolvedGst = (gst_rate != null && !isNaN(Number(gst_rate)))
      ? Number(gst_rate)
      : GST_DEFAULTS[category] ?? 0;

    const resolvedUnitType = VALID_UNIT_TYPES.includes(unit_type)
      ? unit_type
      : defaultUnitType(unit);

    const { data, error } = await supabaseAdmin
      .from('supply_catalog_items')
      .insert({
        supplier_id:   req.supplier_id,
        name:          name.trim(),
        category,
        unit,
        unit_type:     resolvedUnitType,
        default_price: Number(default_price),
        hsn_code:      hsn_code ?? null,
        gst_rate:      resolvedGst,
        min_order_qty: min_order_qty != null ? Number(min_order_qty) : 0,
        display_order: display_order != null ? Number(display_order) : 0,
        is_available,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ item: data });
  } catch (err) {
    console.error('[supply/catalog] POST /', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/supply/catalog/bulk-availability ─────────────────────────────────
// Body: { items: [{ id, is_available }] }
// Used every morning: supplier confirms today's stock in one action.
router.put('/bulk-availability', supplyAuthMiddleware, async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'items array is required' });

    // Validate all IDs belong to this supplier before touching anything
    const ids = items.map(i => i.id).filter(Boolean);
    const { data: owned, error: checkErr } = await supabaseAdmin
      .from('supply_catalog_items')
      .select('id')
      .eq('supplier_id', req.supplier_id)
      .in('id', ids);

    if (checkErr) throw checkErr;
    const ownedIds = new Set((owned ?? []).map(r => r.id));
    const unauthorised = ids.filter(id => !ownedIds.has(id));
    if (unauthorised.length)
      return res.status(403).json({ error: `Item(s) not found or not yours: ${unauthorised.join(', ')}` });

    // Group by is_available value to minimise DB round-trips
    const toEnable  = items.filter(i =>  i.is_available).map(i => i.id);
    const toDisable = items.filter(i => !i.is_available).map(i => i.id);
    const now = new Date().toISOString();

    const ops = [];
    if (toEnable.length)
      ops.push(supabaseAdmin.from('supply_catalog_items')
        .update({ is_available: true })
        .in('id', toEnable));
    if (toDisable.length)
      ops.push(supabaseAdmin.from('supply_catalog_items')
        .update({ is_available: false })
        .in('id', toDisable));

    const results = await Promise.all(ops);
    for (const { error } of results) if (error) throw error;

    res.json({ updated: items.length });
  } catch (err) {
    console.error('[supply/catalog] PUT /bulk-availability', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/supply/catalog/:id ───────────────────────────────────────────────
router.put('/:id', supplyAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // Ownership check
    const { data: existing, error: findErr } = await supabaseAdmin
      .from('supply_catalog_items')
      .select('id, is_active')
      .eq('id', id)
      .eq('supplier_id', req.supplier_id)
      .maybeSingle();

    if (findErr) throw findErr;
    if (!existing || !existing.is_active)
      return res.status(404).json({ error: 'Catalog item not found' });

    const {
      name, category, unit, unit_type, default_price,
      hsn_code, gst_rate, min_order_qty, display_order, is_available,
    } = req.body;

    // Validate only the fields being updated
    const patch = {};
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
      patch.name = name.trim();
    }
    if (category !== undefined) {
      if (!VALID_CATEGORIES.includes(category))
        return res.status(400).json({ error: `Invalid category: ${category}` });
      patch.category = category;
    }
    if (unit !== undefined) {
      if (!VALID_UNITS.includes(unit))
        return res.status(400).json({ error: `Invalid unit: ${unit}` });
      patch.unit = unit;
    }
    if (unit_type !== undefined) {
      if (!VALID_UNIT_TYPES.includes(unit_type))
        return res.status(400).json({ error: `Invalid unit_type: ${unit_type}` });
      patch.unit_type = unit_type;
    }
    if (default_price !== undefined) {
      if (isNaN(Number(default_price)) || Number(default_price) < 0)
        return res.status(400).json({ error: 'default_price must be a non-negative number' });
      patch.default_price = Number(default_price);
    }
    if (gst_rate     !== undefined) patch.gst_rate      = Number(gst_rate);
    if (min_order_qty !== undefined) patch.min_order_qty = Number(min_order_qty);
    if (display_order !== undefined) patch.display_order = Number(display_order);
    if (hsn_code      !== undefined) patch.hsn_code      = hsn_code;
    if (is_available  !== undefined) patch.is_available  = Boolean(is_available);

    if (Object.keys(patch).length === 0)
      return res.status(400).json({ error: 'No fields to update' });

    const { data, error } = await supabaseAdmin
      .from('supply_catalog_items')
      .update(patch)
      .eq('id', id)
      .eq('supplier_id', req.supplier_id)
      .select()
      .single();

    if (error) throw error;
    res.json({ item: data });
  } catch (err) {
    console.error('[supply/catalog] PUT /:id', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/supply/catalog/:id ───────────────────────────────────────────
// Soft delete only — marks is_active = false.
// Hard delete is never done because order_items reference catalog items.
router.delete('/:id', supplyAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabaseAdmin
      .from('supply_catalog_items')
      .update({ is_active: false })
      .eq('id', id)
      .eq('supplier_id', req.supplier_id)
      .select('id')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Catalog item not found' });

    res.json({ deleted: true, id });
  } catch (err) {
    console.error('[supply/catalog] DELETE /:id', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
