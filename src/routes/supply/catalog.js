// src/routes/supply/catalog.js
// ============================================================================
// Munafe Supply — Module 3: Catalog Management
//
// GET    /api/supply/catalog                   — All items for supplier
// GET    /api/supply/catalog/meta              — LOB schema (categories/units/GST)
// POST   /api/supply/catalog                   — Add catalog item
// POST   /api/supply/catalog/bulk-upload       — Bulk create/update from Excel/CSV rows
// PUT    /api/supply/catalog/bulk-availability — Bulk toggle availability
// GET    /api/supply/catalog/available-today   — Items where is_available=true
// PUT    /api/supply/catalog/:id               — Edit catalog item
// DELETE /api/supply/catalog/:id               — Soft delete
//
// Auth: Bearer token → supplyAuthMiddleware (req.supplier_id + req.supplier.lob_type).
// Catalog validation is driven by suppliers.lob_type — buyers may be any LOB.
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin } = require('../../config/supabase');
const { supplyAuthMiddleware } = require('../../middleware/supplyAuth');
const {
  DEFAULT_LOB,
  VALID_UNIT_TYPES,
  getSupplySchema,
  defaultUnitType,
  resolveGst,
  validateItem,
  schemaMeta,
} = require('../../config/supplyCatalogSchemas');

function schemaForReq(req) {
  return getSupplySchema(req.supplier?.lob_type || DEFAULT_LOB);
}

function parseAvailability(raw, defaultVal = true) {
  if (raw === undefined || raw === null || raw === '') return defaultVal;
  const s = String(raw).toLowerCase().trim();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return defaultVal;
}

// ── GET /api/supply/catalog ───────────────────────────────────────────────────
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

// ── GET /api/supply/catalog/meta ──────────────────────────────────────────────
// Dashboard / upload UI: valid categories, units, GST defaults for this supplier.
router.get('/meta', supplyAuthMiddleware, async (req, res) => {
  try {
    const schema = schemaForReq(req);
    res.json(schemaMeta(schema));
  } catch (err) {
    console.error('[supply/catalog] GET /meta', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/supply/catalog/available-today ───────────────────────────────────
// Items visible on the buyer order form today.
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
    const schema = schemaForReq(req);
    const {
      name, category, unit, unit_type, default_price,
      hsn_code, gst_rate, min_order_qty, display_order,
      is_available = true,
    } = req.body;

    const errors = validateItem(schema, req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const resolvedGst = resolveGst(schema, category, gst_rate);
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
        is_available:  Boolean(is_available),
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
// Morning stock confirm — toggles availability only, not product details.
router.put('/bulk-availability', supplyAuthMiddleware, async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'items array is required' });

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

    const toEnable  = items.filter(i =>  i.is_available).map(i => i.id);
    const toDisable = items.filter(i => !i.is_available).map(i => i.id);

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

// ── POST /api/supply/catalog/bulk-upload ──────────────────────────────────────
// Body: { items: [...], replace_existing?: boolean }
// Frontend parses Excel/CSV (SheetJS); this endpoint upserts by name.
// Default: safe upsert — unmatched existing items left alone.
// replace_existing: true → soft-deactivate active items not in this upload.
async function handleCatalogBulkUpload(req, res) {
  try {
    const { items, replace_existing } = req.body;
    if (!items || !Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'items array required' });

    const schema = schemaForReq(req);
    const supplierId = req.supplier_id;
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let deactivated = 0;
    const errors = [];

    const validRows = [];
    items.forEach((item, idx) => {
      const rowLabel = (item.name && String(item.name).trim()) || `row ${idx + 1}`;
      const rowErrors = validateItem(schema, item);
      if (rowErrors.length) {
        errors.push({ row: rowLabel, error: rowErrors.join('; ') });
        skipped += 1;
        return;
      }

      const unit = item.unit;
      const unitType = VALID_UNIT_TYPES.includes(item.unit_type)
        ? item.unit_type
        : defaultUnitType(unit);

      validRows.push({
        name:          String(item.name).trim(),
        category:      item.category,
        unit,
        unit_type:     unitType,
        default_price: Number(item.default_price),
        hsn_code:      item.hsn_code ? String(item.hsn_code).trim() : null,
        gst_rate:      resolveGst(schema, item.category, item.gst_rate),
        min_order_qty: (item.min_order_qty != null && item.min_order_qty !== '')
          ? Number(item.min_order_qty)
          : 0,
        display_order: (item.display_order != null && item.display_order !== '')
          ? Number(item.display_order)
          : 0,
        is_available:  parseAvailability(item.is_available, true),
      });
    });

    if (!validRows.length)
      return res.status(400).json({ error: 'No valid rows found', skipped, errors });

    const { data: existingItems, error: fetchErr } = await supabaseAdmin
      .from('supply_catalog_items')
      .select('id, name')
      .eq('supplier_id', supplierId)
      .eq('is_active', true);
    if (fetchErr) throw fetchErr;

    const byNameLower = new Map(
      (existingItems ?? []).map((r) => [String(r.name || '').trim().toLowerCase(), r.id]),
    );
    const matchedIds = new Set();

    for (const row of validRows) {
      const existingId = byNameLower.get(row.name.toLowerCase());
      try {
        if (existingId) {
          matchedIds.add(existingId);
          const { error: updErr } = await supabaseAdmin
            .from('supply_catalog_items')
            .update(row)
            .eq('id', existingId)
            .eq('supplier_id', supplierId);
          if (updErr) throw updErr;
          updated += 1;
        } else {
          const { error: insErr } = await supabaseAdmin
            .from('supply_catalog_items')
            .insert({ supplier_id: supplierId, is_active: true, ...row });
          if (insErr) throw insErr;
          created += 1;
        }
      } catch (rowErr) {
        errors.push({ row: row.name, error: rowErr.message });
        skipped += 1;
      }
    }

    if (replace_existing === true || replace_existing === 'true') {
      const toDeactivate = (existingItems ?? [])
        .filter((r) => !matchedIds.has(r.id))
        .map((r) => r.id);
      if (toDeactivate.length) {
        const { error: deactErr } = await supabaseAdmin
          .from('supply_catalog_items')
          .update({ is_available: false, is_active: false })
          .in('id', toDeactivate)
          .eq('supplier_id', supplierId);
        if (deactErr) throw deactErr;
        deactivated = toDeactivate.length;
      }
    }

    const response = {
      success: true,
      created,
      updated,
      deactivated,
      skipped,
      total: items.length,
      lob_type: schema.lob_type,
    };
    if (errors.length) response.errors = errors;
    res.json(response);
  } catch (err) {
    console.error('[supply/catalog] POST /bulk-upload', err.message);
    res.status(500).json({ error: err.message });
  }
}

router.post('/bulk-upload', supplyAuthMiddleware, handleCatalogBulkUpload);

// ── PUT /api/supply/catalog/:id ───────────────────────────────────────────────
router.put('/:id', supplyAuthMiddleware, async (req, res) => {
  try {
    const schema = schemaForReq(req);
    const { id } = req.params;

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

    const patch = {};
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
      patch.name = name.trim();
    }
    if (category !== undefined) {
      if (!schema.categories.includes(category))
        return res.status(400).json({ error: `Invalid category: ${category}` });
      patch.category = category;
    }
    if (unit !== undefined) {
      if (!schema.units.includes(unit))
        return res.status(400).json({ error: `Invalid unit: ${unit}` });
      patch.unit = unit;
    }
    if (unit_type !== undefined) {
      if (!VALID_UNIT_TYPES.includes(unit_type))
        return res.status(400).json({ error: `Invalid unit_type: ${unit_type}` });
      patch.unit_type = unit_type;
    }
    if (default_price !== undefined) {
      if (Number.isNaN(Number(default_price)) || Number(default_price) < 0)
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
// Soft delete only — is_active = false (order line items may reference the row).
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
