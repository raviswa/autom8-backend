// src/routes/supply/ratecards.js
// ============================================================================
// Munafe Supply — Module 4: Ratecard Management (Per-Client Pricing)
//
// GET    /api/supply/ratecards/:client_id          — Full ratecard for client
//          Returns ALL catalog items with default_price + client override side-by-side.
// PUT    /api/supply/ratecards/:client_id          — Bulk upsert overrides
//          Body: { items: [{ item_id, price }] }
// DELETE /api/supply/ratecards/:client_id/:item_id — Remove override → revert to default
// POST   /api/supply/ratecards/copy               — Copy one client's ratecard to another
//          Body: { from_client_id, to_client_id }
//
// Price resolution logic (shared with Module 5 order form):
//   resolve_price(client_id, item_id)
//     → supply_client_prices row if exists
//     → else supply_catalog_items.default_price
//
// All routes require Bearer JWT (supply JWT). Middleware attaches req.supplier_id.
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin }        = require('../../config/supabase');
const { supplyAuthMiddleware } = require('../../middleware/supplyAuth');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Verify a client_id belongs to req.supplier_id. Returns the client row or null. */
async function resolveClient(supplierId, clientId) {
  const { data } = await supabaseAdmin
    .from('supply_clients')
    .select('id, name, is_active')
    .eq('id', clientId)
    .eq('supplier_id', supplierId)
    .maybeSingle();
  return data;
}

// ── GET /api/supply/ratecards/:client_id ─────────────────────────────────────
// Returns all active catalog items for the supplier, each annotated with:
//   - default_price  (from supply_catalog_items)
//   - client_price   (from supply_client_prices, null if no override)
//   - has_override   (boolean)
//   - effective_price (resolved price the client will see on the order form)
router.get('/:client_id', supplyAuthMiddleware, async (req, res) => {
  try {
    const { client_id } = req.params;

    // Verify client ownership
    const client = await resolveClient(req.supplier_id, client_id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Fetch all active catalog items
    const { data: items, error: itemErr } = await supabaseAdmin
      .from('supply_catalog_items')
      .select('id, name, category, unit, default_price, gst_rate, min_order_qty, display_order, is_available, is_active')
      .eq('supplier_id', req.supplier_id)
      .eq('is_active', true)
      .order('category',      { ascending: true })
      .order('display_order', { ascending: true })
      .order('name',          { ascending: true });

    if (itemErr) throw itemErr;

    // Fetch all price overrides for this client in one query
    const { data: overrides, error: ovErr } = await supabaseAdmin
      .from('supply_client_prices')
      .select('item_id, price')
      .eq('client_id', client_id)
      .eq('supplier_id', req.supplier_id);

    if (ovErr) throw ovErr;

    const overrideMap = new Map((overrides ?? []).map(r => [r.item_id, r.price]));

    // Annotate each item
    const ratecard = (items ?? []).map(item => {
      const client_price = overrideMap.has(item.id) ? Number(overrideMap.get(item.id)) : null;
      return {
        ...item,
        client_price,
        has_override:    client_price !== null,
        effective_price: client_price !== null ? client_price : Number(item.default_price),
      };
    });

    res.json({ client: { id: client.id, name: client.name }, ratecard });
  } catch (err) {
    console.error('[supply/ratecards] GET /:client_id', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/supply/ratecards/:client_id ─────────────────────────────────────
// Bulk upsert price overrides. Saves all changes in one API call.
// Body: { items: [{ item_id, price }] }
// Send price: null to remove a specific override (reverts to default).
router.put('/:client_id', supplyAuthMiddleware, async (req, res) => {
  try {
    const { client_id } = req.params;
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'items array is required' });

    // Verify client ownership
    const client = await resolveClient(req.supplier_id, client_id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Validate all item_ids belong to this supplier
    const itemIds = items.map(i => i.item_id).filter(Boolean);
    const { data: ownedItems, error: ownedErr } = await supabaseAdmin
      .from('supply_catalog_items')
      .select('id')
      .eq('supplier_id', req.supplier_id)
      .eq('is_active', true)
      .in('id', itemIds);

    if (ownedErr) throw ownedErr;
    const ownedSet = new Set((ownedItems ?? []).map(r => r.id));
    const badIds = itemIds.filter(id => !ownedSet.has(id));
    if (badIds.length)
      return res.status(400).json({ error: `Item(s) not found: ${badIds.join(', ')}` });

    // Split into upserts and deletions (price === null means remove override)
    const toUpsert = items
      .filter(i => i.price !== null && i.price !== undefined && !isNaN(Number(i.price)))
      .map(i => ({
        supplier_id: req.supplier_id,
        client_id,
        item_id:    i.item_id,
        price:      Number(i.price),
        updated_at: new Date().toISOString(),
      }));

    const toDelete = items
      .filter(i => i.price === null)
      .map(i => i.item_id);

    const ops = [];

    if (toUpsert.length) {
      ops.push(
        supabaseAdmin
          .from('supply_client_prices')
          .upsert(toUpsert, { onConflict: 'client_id,item_id' })
      );
    }

    if (toDelete.length) {
      ops.push(
        supabaseAdmin
          .from('supply_client_prices')
          .delete()
          .eq('client_id', client_id)
          .eq('supplier_id', req.supplier_id)
          .in('item_id', toDelete)
      );
    }

    const results = await Promise.all(ops);
    for (const { error } of results) if (error) throw error;

    res.json({ upserted: toUpsert.length, removed: toDelete.length });
  } catch (err) {
    console.error('[supply/ratecards] PUT /:client_id', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/supply/ratecards/:client_id/:item_id ─────────────────────────
// Remove a single price override → client reverts to default_price for that item.
router.delete('/:client_id/:item_id', supplyAuthMiddleware, async (req, res) => {
  try {
    const { client_id, item_id } = req.params;

    const client = await resolveClient(req.supplier_id, client_id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { data, error } = await supabaseAdmin
      .from('supply_client_prices')
      .delete()
      .eq('supplier_id', req.supplier_id)
      .eq('client_id', client_id)
      .eq('item_id', item_id)
      .select('id')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'No override found for this item' });

    res.json({ removed: true, item_id });
  } catch (err) {
    console.error('[supply/ratecards] DELETE /:client_id/:item_id', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/supply/ratecards/copy ──────────────────────────────────────────
// Copy all price overrides from one client to another as a starting point.
// Existing overrides on to_client_id are replaced.
// Body: { from_client_id, to_client_id }
router.post('/copy', supplyAuthMiddleware, async (req, res) => {
  try {
    const { from_client_id, to_client_id } = req.body;

    if (!from_client_id || !to_client_id)
      return res.status(400).json({ error: 'from_client_id and to_client_id are required' });

    if (from_client_id === to_client_id)
      return res.status(400).json({ error: 'from and to clients must be different' });

    // Verify both clients belong to this supplier
    const [fromClient, toClient] = await Promise.all([
      resolveClient(req.supplier_id, from_client_id),
      resolveClient(req.supplier_id, to_client_id),
    ]);
    if (!fromClient) return res.status(404).json({ error: 'Source client not found' });
    if (!toClient)   return res.status(404).json({ error: 'Target client not found' });

    // Fetch source ratecard
    const { data: sourceOverrides, error: srcErr } = await supabaseAdmin
      .from('supply_client_prices')
      .select('item_id, price')
      .eq('supplier_id', req.supplier_id)
      .eq('client_id', from_client_id);

    if (srcErr) throw srcErr;

    if (!sourceOverrides?.length)
      return res.json({ copied: 0, message: 'Source client has no overrides to copy' });

    // Delete existing overrides on target then bulk insert source
    const { error: delErr } = await supabaseAdmin
      .from('supply_client_prices')
      .delete()
      .eq('supplier_id', req.supplier_id)
      .eq('client_id', to_client_id);

    if (delErr) throw delErr;

    const rows = sourceOverrides.map(r => ({
      supplier_id: req.supplier_id,
      client_id:   to_client_id,
      item_id:     r.item_id,
      price:       r.price,
      updated_at:  new Date().toISOString(),
    }));

    const { error: insErr } = await supabaseAdmin
      .from('supply_client_prices')
      .insert(rows);

    if (insErr) throw insErr;

    res.json({
      copied:      rows.length,
      from_client: fromClient.name,
      to_client:   toClient.name,
    });
  } catch (err) {
    console.error('[supply/ratecards] POST /copy', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Exported helper: resolve_price ───────────────────────────────────────────
// Used by Module 5 (order form) and Module 11 (WhatsApp bot).
// Returns the effective price for a (client_id, item_id) pair.
//
// Usage:
//   const { resolvePrice } = require('./ratecards');
//   const price = await resolvePrice(client_id, item_id, default_price);
//
async function resolvePrice(client_id, item_id, default_price) {
  const { data } = await supabaseAdmin
    .from('supply_client_prices')
    .select('price')
    .eq('client_id', client_id)
    .eq('item_id', item_id)
    .maybeSingle();

  return data ? Number(data.price) : Number(default_price);
}

module.exports = router;
module.exports.resolvePrice = resolvePrice;
