'use strict';

/**
 * Batch inventory helpers — qty tracking + sold-out + waitlist WhatsApp.
 * current_stock NULL = unlimited (boolean toggle only).
 * BUNDLE lines also deduct component SKUs from bundle_components / meta.
 */

const { sendWhatsAppMessage } = require('./whatsapp');

function parseBundleComponents(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((c) => ({
        retailer_id: String(c.retailer_id || c.id || '').trim().toUpperCase(),
        qty: Math.max(1, parseInt(c.qty ?? c.quantity ?? 1, 10) || 1),
      }))
      .filter((c) => c.retailer_id);
  }
  const s = String(raw || '').trim();
  if (!s) return [];
  return s.split(/[,;]+/).map((part) => {
    const [id, q] = part.trim().split(':');
    return {
      retailer_id: String(id || '').trim().toUpperCase(),
      qty: Math.max(1, parseInt(q, 10) || 1),
    };
  }).filter((c) => c.retailer_id);
}

function componentsFromItem(row) {
  const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
  const fromMeta = parseBundleComponents(meta.bundle_components);
  if (fromMeta.length) return fromMeta;
  return parseBundleComponents(row?.bundle_components);
}

async function setItemStocked(supabaseAdmin, {
  restaurantId,
  itemId,
  isStocked,
  currentStock = undefined,
  availabilityStatus = undefined,
}) {
  const patch = {
    is_stocked: !!isStocked,
    is_available: !!isStocked,
    updated_at: new Date().toISOString(),
  };
  if (currentStock !== undefined) {
    patch.current_stock = currentStock;
  }
  if (availabilityStatus !== undefined) {
    patch.availability_status = availabilityStatus;
  }
  const { error } = await supabaseAdmin
    .from('menu_items')
    .update(patch)
    .eq('id', itemId)
    .eq('restaurant_id', restaurantId);
  if (error) throw error;
}

/**
 * Soft-hold / deduct qty on order submit.
 * Expands BUNDLE lines into component SKU deductions.
 * Returns { ok, shortages: [{ name, asked, available }], updates: [...] }
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve stock needs for cart lines (BUNDLE expands to components).
 * @param {{ dryRun?: boolean }} [opts] — when dryRun, do not write stock.
 */
async function deductStockForLines(supabaseAdmin, restaurantId, lines, opts = {}) {
  const dryRun = !!opts.dryRun;
  const shortages = [];
  const neededById = new Map(); // id -> { qty, name, retailer_id, low_stock_alert_units }
  const rowCache = new Map();

  const loadById = async (id) => {
    if (!id || !UUID_RE.test(String(id))) return null;
    if (rowCache.has(id)) return rowCache.get(id);
    const { data: row, error } = await supabaseAdmin
      .from('menu_items')
      .select('id, name, retailer_id, current_stock, is_stocked, item_type, bundle_components, meta, low_stock_alert_units, price, discount_percent, discount_ends_at, archived_at')
      .eq('id', id)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (error) throw error;
    rowCache.set(id, row || null);
    return row || null;
  };

  const loadByRetailerId = async (retailerId) => {
    const key = String(retailerId || '').trim().toUpperCase();
    if (!key) return null;
    for (const row of rowCache.values()) {
      if (row && String(row.retailer_id || '').toUpperCase() === key) return row;
    }
    const { data: row, error } = await supabaseAdmin
      .from('menu_items')
      .select('id, name, retailer_id, current_stock, is_stocked, item_type, bundle_components, meta, low_stock_alert_units, price, discount_percent, discount_ends_at, archived_at')
      .eq('restaurant_id', restaurantId)
      .ilike('retailer_id', key)
      .is('archived_at', null)
      .maybeSingle();
    if (error) throw error;
    if (row) rowCache.set(row.id, row);
    return row || null;
  };

  const resolveLineItem = async (itemId) => {
    const byId = await loadById(itemId);
    if (byId) return byId;
    return loadByRetailerId(itemId);
  };

  const addNeed = (row, qty) => {
    if (!row || !qty) return;
    if (row.current_stock == null) return; // unlimited
    const prev = neededById.get(row.id) || {
      qty: 0,
      name: row.name,
      retailer_id: row.retailer_id,
      low_stock_alert_units: row.low_stock_alert_units,
      available: Math.max(0, parseInt(row.current_stock, 10) || 0),
    };
    prev.qty += qty;
    neededById.set(row.id, prev);
  };

  for (const line of lines || []) {
    const itemId = line.menu_item_id || line.id;
    if (!itemId) continue;
    const qty = Math.max(0, Math.floor(Number(line.qty || 0)));
    if (!qty) continue;

    const row = await resolveLineItem(itemId);
    if (!row || row.archived_at) {
      shortages.push({
        name: line.name || String(itemId),
        asked: qty,
        available: 0,
        retailer_id: null,
        menu_item_id: null,
      });
      continue;
    }
    if (row.is_stocked === false) {
      shortages.push({
        name: row.name,
        asked: qty,
        available: 0,
        retailer_id: row.retailer_id,
        menu_item_id: row.id,
      });
      continue;
    }

    const itemType = String(row.item_type || 'PRODUCT').toUpperCase();
    if (itemType === 'BUNDLE' || itemType === 'HAMPER') {
      // Also deduct bundle SKU itself when it tracks qty
      addNeed(row, qty);
      const comps = componentsFromItem(row);
      for (const c of comps) {
        const comp = await loadByRetailerId(c.retailer_id);
        if (!comp || comp.is_stocked === false) {
          shortages.push({
            name: `${row.name} (missing component ${c.retailer_id})`,
            asked: qty * c.qty,
            available: 0,
            retailer_id: c.retailer_id,
            menu_item_id: comp?.id || null,
          });
          continue;
        }
        addNeed(comp, qty * c.qty);
      }
    } else {
      addNeed(row, qty);
    }
  }

  for (const [id, need] of neededById.entries()) {
    if (need.available < need.qty) {
      shortages.push({
        name: need.name,
        asked: need.qty,
        available: need.available,
        retailer_id: need.retailer_id,
        menu_item_id: id,
      });
    }
  }

  if (shortages.length) {
    return { ok: false, shortages, updates: [] };
  }

  const updates = [];
  for (const [id, need] of neededById.entries()) {
    const next = need.available - need.qty;
    updates.push({
      id,
      name: need.name,
      retailer_id: need.retailer_id,
      previous: need.available,
      next,
      sold_out: next <= 0,
      low_stock_alert_units: need.low_stock_alert_units,
    });
  }

  if (dryRun) {
    return { ok: true, shortages: [], updates };
  }

  for (const u of updates) {
    await setItemStocked(supabaseAdmin, {
      restaurantId,
      itemId: u.id,
      isStocked: u.next > 0,
      currentStock: u.next,
      availabilityStatus: u.next > 0 ? 'in_stock' : 'sold_out',
    });
  }

  return { ok: true, shortages: [], updates };
}

/**
 * Validate stock + reprice cart lines from live menu (REPEAT / internal).
 * Returns priced lines with UUID ids suitable for later deduct.
 */
async function validateAndPriceLines(supabaseAdmin, restaurantId, lines) {
  const { deriveMenuDiscount } = require('./menuDiscount');
  const priced = [];
  const shortages = [];

  for (const line of lines || []) {
    const itemId = line.menu_item_id || line.id;
    const qty = Math.max(0, Math.floor(Number(line.qty || 0)));
    if (!itemId || !qty) continue;

    let row = null;
    if (UUID_RE.test(String(itemId))) {
      const { data, error } = await supabaseAdmin
        .from('menu_items')
        .select('id, name, retailer_id, price, discount_percent, discount_ends_at, current_stock, is_stocked, item_type, bundle_components, meta, archived_at, low_stock_alert_units')
        .eq('id', itemId)
        .eq('restaurant_id', restaurantId)
        .maybeSingle();
      if (error) throw error;
      row = data;
    }
    if (!row) {
      const key = String(itemId).trim().toUpperCase();
      const { data, error } = await supabaseAdmin
        .from('menu_items')
        .select('id, name, retailer_id, price, discount_percent, discount_ends_at, current_stock, is_stocked, item_type, bundle_components, meta, archived_at, low_stock_alert_units')
        .eq('restaurant_id', restaurantId)
        .ilike('retailer_id', key)
        .is('archived_at', null)
        .maybeSingle();
      if (error) throw error;
      row = data;
    }

    if (!row || row.archived_at || row.is_stocked === false) {
      shortages.push({
        name: row?.name || line.name || String(itemId),
        asked: qty,
        available: 0,
        retailer_id: row?.retailer_id || null,
        menu_item_id: row?.id || null,
      });
      continue;
    }

    const discount = deriveMenuDiscount(row);
    const unitPrice = Number(discount.effective_price || row.price || 0);
    priced.push({
      id: row.id,
      menu_item_id: row.id,
      retailer_id: row.retailer_id,
      name: row.name,
      qty,
      unit_price: unitPrice,
      price: unitPrice,
      list_price: Number(row.price) || 0,
      discount_percent: discount.discount_active ? discount.discount_percent : null,
    });
  }

  const stockPreview = await deductStockForLines(
    supabaseAdmin,
    restaurantId,
    priced.map((p) => ({ id: p.id, menu_item_id: p.id, qty: p.qty, name: p.name })),
    { dryRun: true },
  );
  if (!stockPreview.ok) {
    return {
      ok: false,
      shortages: [...shortages, ...(stockPreview.shortages || [])],
      lines: priced,
      total: priced.reduce((s, p) => s + p.unit_price * p.qty, 0),
    };
  }
  if (shortages.length) {
    return {
      ok: false,
      shortages,
      lines: priced,
      total: priced.reduce((s, p) => s + p.unit_price * p.qty, 0),
    };
  }

  const total = priced.reduce((s, p) => s + p.unit_price * p.qty, 0);
  return { ok: true, shortages: [], lines: priced, total };
}

/**
 * Whether a BUNDLE can sell one unit given component stock.
 * componentsByRetailerId: Map/object of UPPER retailer_id -> { current_stock, is_stocked }
 */
function bundleComponentsCovered(item, componentsByRetailerId, units = 1) {
  const comps = componentsFromItem(item);
  if (!comps.length) return false;
  for (const c of comps) {
    const key = c.retailer_id;
    const comp = componentsByRetailerId.get
      ? componentsByRetailerId.get(key)
      : componentsByRetailerId[key];
    if (!comp) return false;
    if (comp.is_stocked === false) return false;
    if (comp.current_stock == null) continue; // unlimited component
    const avail = Math.max(0, parseInt(comp.current_stock, 10) || 0);
    if (avail < c.qty * units) return false;
  }
  return true;
}

async function restockItem(supabaseAdmin, {
  restaurantId,
  itemId,
  addQty = null,
  setQty = null,
}) {
  const { data: row, error } = await supabaseAdmin
    .from('menu_items')
    .select('id, name, retailer_id, current_stock, is_stocked, availability_status')
    .eq('id', itemId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error('Menu item not found');

  let next;
  if (setQty != null && setQty !== '') {
    next = Math.max(0, parseInt(setQty, 10) || 0);
  } else {
    const add = Math.max(0, parseInt(addQty, 10) || 0);
    const prev = row.current_stock == null ? 0 : (parseInt(row.current_stock, 10) || 0);
    next = prev + add;
  }

  const wasOut = !row.is_stocked || (row.current_stock != null && Number(row.current_stock) <= 0);
  const isPrelaunch = ['coming_soon', 'preorder'].includes(String(row.availability_status || '').toLowerCase());
  const nowInStock = next > 0 && !isPrelaunch;
  await setItemStocked(supabaseAdmin, {
    restaurantId,
    itemId: row.id,
    isStocked: nowInStock,
    currentStock: next,
    availabilityStatus: isPrelaunch
      ? row.availability_status
      : (next > 0 ? 'in_stock' : 'sold_out'),
  });

  return {
    id: row.id,
    name: row.name,
    retailer_id: row.retailer_id,
    previous_stock: row.current_stock == null ? null : Math.max(0, parseInt(row.current_stock, 10) || 0),
    current_stock: next,
    availability_status: isPrelaunch ? row.availability_status : (next > 0 ? 'in_stock' : 'sold_out'),
    was_out: wasOut,
    now_in_stock: nowInStock,
  };
}

async function joinStockWaitlist(supabaseAdmin, {
  restaurantId,
  phone,
  menuItemId = null,
  retailerId = null,
  itemName = null,
  reason = 'restock',
}) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) throw new Error('Valid phone required');
  const rid = retailerId ? String(retailerId).trim() : (menuItemId ? String(menuItemId) : null);
  if (!rid && !menuItemId) throw new Error('menu_item_id or retailer_id required');

  const row = {
    restaurant_id: restaurantId,
    menu_item_id: menuItemId || null,
    retailer_id: rid,
    item_name: itemName || null,
    customer_phone: digits.length === 10 ? `91${digits}` : digits,
    reason: reason === 'launch' ? 'launch' : 'restock',
    notified_at: null,
  };

  const { data, error } = await supabaseAdmin
    .from('stock_waitlist')
    .upsert(row, { onConflict: 'restaurant_id,customer_phone,retailer_id' })
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Notify waitlisted customers that an item is back. Marks rows notified.
 */
async function notifyStockWaitlist(supabaseAdmin, {
  restaurantId,
  menuItemId = null,
  retailerId = null,
  itemName = 'your item',
  reason = null,
}) {
  let query = supabaseAdmin
    .from('stock_waitlist')
    .select('id, customer_phone, item_name, retailer_id, reason')
    .eq('restaurant_id', restaurantId)
    .is('notified_at', null)
    .limit(200);

  if (retailerId) query = query.eq('retailer_id', String(retailerId));
  else if (menuItemId) query = query.eq('menu_item_id', menuItemId);
  else return { notified: 0 };

  if (reason) query = query.eq('reason', reason);

  const { data: rows, error } = await query;
  if (error) throw error;
  if (!rows?.length) return { notified: 0 };

  const label = itemName || rows[0].item_name || 'your item';
  let notified = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    const msg = reason === 'launch'
      ? `It's here! *${label}* just launched.\n` +
        `Reply or open your cart link to be among the first to order.`
      : `Good news! *${label}* is back in stock.\n` +
        `Reply or open your cart link to order before this batch sells out.`;
    try {
      const ok = await sendWhatsAppMessage(row.customer_phone, msg, restaurantId);
      if (ok) {
        await supabaseAdmin
          .from('stock_waitlist')
          .update({ notified_at: now })
          .eq('id', row.id);
        notified += 1;
      }
    } catch (err) {
      console.warn('[stock-waitlist] notify failed:', err.message);
    }
  }

  return { notified };
}

module.exports = {
  setItemStocked,
  deductStockForLines,
  validateAndPriceLines,
  restockItem,
  joinStockWaitlist,
  notifyStockWaitlist,
  parseBundleComponents,
  componentsFromItem,
  bundleComponentsCovered,
};
