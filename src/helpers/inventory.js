'use strict';

/**
 * Batch inventory helpers — qty tracking + sold-out + waitlist WhatsApp.
 * current_stock NULL = unlimited (boolean toggle only).
 */

const { sendWhatsAppMessage } = require('./whatsapp');

async function setItemStocked(supabaseAdmin, {
  restaurantId,
  itemId,
  isStocked,
  currentStock = undefined,
}) {
  const patch = {
    is_stocked: !!isStocked,
    is_available: !!isStocked,
    updated_at: new Date().toISOString(),
  };
  if (currentStock !== undefined) {
    patch.current_stock = currentStock;
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
 * Returns { ok, shortages: [{ name, asked, available }], updates: [...] }
 */
async function deductStockForLines(supabaseAdmin, restaurantId, lines) {
  const shortages = [];
  const updates = [];

  for (const line of lines || []) {
    const itemId = line.menu_item_id || line.id;
    if (!itemId) continue;
    const qty = Math.max(0, Math.floor(Number(line.qty || 0)));
    if (!qty) continue;

    const { data: row, error } = await supabaseAdmin
      .from('menu_items')
      .select('id, name, retailer_id, current_stock, is_stocked')
      .eq('id', itemId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (error) throw error;
    if (!row) continue;
    if (row.current_stock == null) continue; // unlimited / toggle-only

    const available = Math.max(0, parseInt(row.current_stock, 10) || 0);
    if (available < qty) {
      shortages.push({
        name: row.name,
        asked: qty,
        available,
        retailer_id: row.retailer_id,
        menu_item_id: row.id,
      });
      continue;
    }

    const next = available - qty;
    updates.push({
      id: row.id,
      name: row.name,
      retailer_id: row.retailer_id,
      previous: available,
      next,
      sold_out: next <= 0,
    });
  }

  if (shortages.length) {
    return { ok: false, shortages, updates: [] };
  }

  for (const u of updates) {
    await setItemStocked(supabaseAdmin, {
      restaurantId,
      itemId: u.id,
      isStocked: u.next > 0,
      currentStock: u.next,
    });
  }

  return { ok: true, shortages: [], updates };
}

async function restockItem(supabaseAdmin, {
  restaurantId,
  itemId,
  addQty = null,
  setQty = null,
}) {
  const { data: row, error } = await supabaseAdmin
    .from('menu_items')
    .select('id, name, retailer_id, current_stock, is_stocked')
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
  await setItemStocked(supabaseAdmin, {
    restaurantId,
    itemId: row.id,
    isStocked: next > 0,
    currentStock: next,
  });

  return {
    id: row.id,
    name: row.name,
    retailer_id: row.retailer_id,
    current_stock: next,
    was_out: wasOut,
    now_in_stock: next > 0,
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
}) {
  let query = supabaseAdmin
    .from('stock_waitlist')
    .select('id, customer_phone, item_name, retailer_id')
    .eq('restaurant_id', restaurantId)
    .is('notified_at', null)
    .limit(200);

  if (retailerId) query = query.eq('retailer_id', String(retailerId));
  else if (menuItemId) query = query.eq('menu_item_id', menuItemId);
  else return { notified: 0 };

  const { data: rows, error } = await query;
  if (error) throw error;
  if (!rows?.length) return { notified: 0 };

  const label = itemName || rows[0].item_name || 'your item';
  let notified = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    const msg =
      `Good news! *${label}* is back in stock.\n` +
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
  restockItem,
  joinStockWaitlist,
  notifyStockWaitlist,
};
