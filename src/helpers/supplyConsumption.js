'use strict';

/**
 * POS ↔ Supply inventory bridge helpers.
 * Consumption is append-only; does not mutate supply catalog stock.
 */

const { supabaseAdmin } = require('../config/supabase');

function isMissingRelation(err) {
  return /menu_item_supply_sku|supply_consumption_ledger|42p01|pgrst205/i.test(
    `${err?.code || ''} ${err?.message || ''}`,
  );
}

/**
 * Record consumption for a fulfilled booking using opt-in menu_item_supply_sku maps.
 * cartLines: [{ menu_item_id?, retailer_id?, id?, qty }]
 */
async function recordConsumptionForBooking({
  restaurantId,
  bookingId,
  cartLines,
}) {
  if (!restaurantId || !bookingId) return { ok: false, inserted: 0 };

  const lines = (cartLines || [])
    .map((l) => ({
      key: String(l.menu_item_id || l.id || l.retailer_id || '').trim(),
      qty: Math.max(0, Number(l.qty || l.quantity || 0)),
    }))
    .filter((l) => l.key && l.qty > 0);
  if (!lines.length) return { ok: true, inserted: 0 };

  const keys = [...new Set(lines.map((l) => l.key))];
  const uuidKeys = keys.filter((k) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(k),
  );
  const retailerKeys = keys.filter((k) => !uuidKeys.includes(k));

  const menuRows = [];
  if (uuidKeys.length) {
    const { data, error } = await supabaseAdmin
      .from('menu_items')
      .select('id, retailer_id')
      .eq('restaurant_id', restaurantId)
      .in('id', uuidKeys);
    if (error) throw error;
    menuRows.push(...(data || []));
  }
  if (retailerKeys.length) {
    const { data, error } = await supabaseAdmin
      .from('menu_items')
      .select('id, retailer_id')
      .eq('restaurant_id', restaurantId)
      .in('retailer_id', retailerKeys);
    if (error) throw error;
    menuRows.push(...(data || []));
  }

  const idByKey = new Map();
  for (const row of menuRows) {
    idByKey.set(String(row.id), row.id);
    if (row.retailer_id) idByKey.set(String(row.retailer_id), row.id);
  }

  const qtyByMenuId = new Map();
  for (const line of lines) {
    const mid = idByKey.get(line.key);
    if (!mid) continue;
    qtyByMenuId.set(mid, (qtyByMenuId.get(mid) || 0) + line.qty);
  }
  if (!qtyByMenuId.size) return { ok: true, inserted: 0 };

  const menuIds = [...qtyByMenuId.keys()];
  const { data: maps, error: mapErr } = await supabaseAdmin
    .from('menu_item_supply_sku')
    .select('menu_item_id, supply_client_id, supply_sku_id, consumption_ratio')
    .eq('restaurant_id', restaurantId)
    .in('menu_item_id', menuIds);
  if (mapErr) {
    if (isMissingRelation(mapErr)) return { ok: true, inserted: 0, skipped: 'no_mapping_table' };
    throw mapErr;
  }
  if (!maps?.length) return { ok: true, inserted: 0 };

  const rows = [];
  for (const m of maps) {
    const sold = qtyByMenuId.get(m.menu_item_id) || 0;
    const ratio = Number(m.consumption_ratio) || 1;
    const qty = +(sold * ratio).toFixed(4);
    if (qty <= 0) continue;
    rows.push({
      restaurant_id: restaurantId,
      supply_client_id: m.supply_client_id,
      supply_sku_id: m.supply_sku_id,
      menu_item_id: m.menu_item_id,
      booking_id: bookingId,
      qty_consumed: qty,
    });
  }
  if (!rows.length) return { ok: true, inserted: 0 };

  let inserted = 0;
  for (const row of rows) {
    const { error } = await supabaseAdmin.from('supply_consumption_ledger').insert(row);
    if (!error) {
      inserted += 1;
      continue;
    }
    if (/duplicate|unique|23505/i.test(`${error.code || ''} ${error.message || ''}`)) continue;
    if (isMissingRelation(error)) return { ok: true, inserted: 0, skipped: 'no_ledger_table' };
    throw error;
  }
  return { ok: true, inserted };
}

/**
 * Estimated days of stock left per catalog SKU for this supplier's linked clients.
 * remaining ≈ last_delivery_qty − consumption_since; days = remaining / daily_rate.
 */
async function estimateDaysOfStock(supplierId) {
  const { data: clients, error: cErr } = await supabaseAdmin
    .from('supply_clients')
    .select('id, name, munafe_restaurant_id')
    .eq('supplier_id', supplierId)
    .eq('is_active', true)
    .not('munafe_restaurant_id', 'is', null);
  if (cErr) throw cErr;
  if (!clients?.length) return [];

  const clientIds = clients.map((c) => c.id);
  const clientName = Object.fromEntries(clients.map((c) => [c.id, c.name]));

  const { data: maps, error: mErr } = await supabaseAdmin
    .from('menu_item_supply_sku')
    .select('supply_client_id, supply_sku_id')
    .in('supply_client_id', clientIds);
  if (mErr) {
    if (isMissingRelation(mErr)) return [];
    throw mErr;
  }
  if (!maps?.length) return [];

  const skuIds = [...new Set(maps.map((m) => m.supply_sku_id))];
  const { data: catalog } = await supabaseAdmin
    .from('supply_catalog_items')
    .select('id, name, unit')
    .eq('supplier_id', supplierId)
    .in('id', skuIds);
  const skuMeta = Object.fromEntries((catalog || []).map((s) => [s.id, s]));

  const lookbackDays = 14;
  const sinceIso = new Date(Date.now() - lookbackDays * 86400000).toISOString();

  const estimates = [];
  const pairs = new Map();
  for (const m of maps) {
    pairs.set(`${m.supply_client_id}:${m.supply_sku_id}`, {
      supply_client_id: m.supply_client_id,
      supply_sku_id: m.supply_sku_id,
    });
  }

  for (const pair of pairs.values()) {
    const { supply_client_id: clientId, supply_sku_id: skuId } = pair;
    const meta = skuMeta[skuId];
    if (!meta) continue;

    const { data: recentOrders } = await supabaseAdmin
      .from('supply_orders')
      .select('id, created_at, delivered_at, status')
      .eq('supplier_id', supplierId)
      .eq('client_id', clientId)
      .in('status', ['delivered', 'partially_delivered', 'completed'])
      .order('created_at', { ascending: false })
      .limit(8);

    let lastQty = 0;
    let lastAt = null;
    for (const ord of recentOrders || []) {
      const { data: oi } = await supabaseAdmin
        .from('supply_order_items')
        .select('qty_ordered, qty_delivered')
        .eq('order_id', ord.id)
        .eq('item_id', skuId)
        .maybeSingle();
      if (!oi) continue;
      const q = Number(oi.qty_delivered != null ? oi.qty_delivered : oi.qty_ordered) || 0;
      if (q <= 0) continue;
      lastQty = q;
      lastAt = ord.delivered_at || ord.created_at || null;
      break;
    }

    const { data: consumedRows, error: consErr } = await supabaseAdmin
      .from('supply_consumption_ledger')
      .select('qty_consumed, created_at')
      .eq('supply_client_id', clientId)
      .eq('supply_sku_id', skuId)
      .gte('created_at', sinceIso);
    if (consErr) {
      if (isMissingRelation(consErr)) return [];
      throw consErr;
    }

    const consumedLookback = (consumedRows || []).reduce(
      (s, r) => s + Number(r.qty_consumed || 0),
      0,
    );
    const consumedSinceDelivery = (consumedRows || [])
      .filter((r) => !lastAt || new Date(r.created_at) >= new Date(lastAt))
      .reduce((s, r) => s + Number(r.qty_consumed || 0), 0);

    const remaining = Math.max(0, lastQty - consumedSinceDelivery);
    const dailyRate = consumedLookback / lookbackDays;
    let daysLeft = null;
    if (dailyRate > 0.0001) {
      daysLeft = +(remaining / dailyRate).toFixed(1);
    } else if (remaining <= 0 && lastQty > 0) {
      daysLeft = 0;
    }

    estimates.push({
      supply_sku_id: skuId,
      sku_name: meta.name,
      unit: meta.unit,
      supply_client_id: clientId,
      client_name: clientName[clientId] || null,
      last_delivery_qty: lastQty,
      last_delivery_at: lastAt,
      consumed_14d: +consumedLookback.toFixed(3),
      remaining_est: +remaining.toFixed(3),
      daily_rate: +dailyRate.toFixed(4),
      days_of_stock_est: daysLeft,
    });
  }

  return estimates;
}

module.exports = {
  recordConsumptionForBooking,
  estimateDaysOfStock,
};
