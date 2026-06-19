// src/helpers/tableRelease.js
// Free all tables tied to a walk-in token (including large-party multi-table combos).

'use strict';

const { queueFeedbackForTable } = require('./feedback');

const ACTIVE_ORDER_STATUSES = ['pending', 'confirmed', 'in_progress'];

/**
 * All table UUIDs for a token: primary table_id + meta.table_ids + meta.combo lookup.
 */
async function resolveTokenTableIds(supabaseAdmin, token, restaurantId) {
  const ids = new Set();
  if (token?.table_id) ids.add(token.table_id);

  const meta = token?.meta || {};
  for (const id of meta.table_ids || []) {
    if (id) ids.add(id);
  }

  const tableNumbers = new Set();
  for (const n of meta.table_numbers || []) {
    if (n != null && n !== '') tableNumbers.add(parseInt(String(n), 10));
  }
  for (const row of meta.combo || []) {
    if (row?.[0] != null) tableNumbers.add(parseInt(String(row[0]), 10));
  }

  const nums = [...tableNumbers].filter(n => !Number.isNaN(n));
  if (nums.length) {
    const { data: rows } = await supabaseAdmin
      .from('tables')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .in('table_number', nums);
    for (const row of rows ?? []) ids.add(row.id);
  }

  return [...ids];
}

/**
 * True when a seated token still holds this table (primary or large-party combo).
 */
async function findSeatedTokenHoldingTable(supabaseAdmin, tableId, tableNumber, restaurantId) {
  const { data: seated } = await supabaseAdmin
    .from('walk_in_tokens')
    .select('id, table_id, meta')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'seated');

  for (const token of seated ?? []) {
    if (token.table_id === tableId) return token.id;
    const meta = token.meta || {};
    if ((meta.table_ids || []).includes(tableId)) return token.id;
    const nums = new Set([
      ...(meta.table_numbers || []).map(String),
      ...(meta.combo || []).map(c => String(c[0])),
    ]);
    if (nums.has(String(tableNumber))) return token.id;
  }
  return null;
}

async function tableHasActiveOrders(supabaseAdmin, tableId) {
  const { data: activeOrders } = await supabaseAdmin
    .from('orders')
    .select('id')
    .eq('table_id', tableId)
    .in('status', ACTIVE_ORDER_STATUSES)
    .limit(1);
  return Boolean(activeOrders?.length);
}

/**
 * Mark tables available when no active orders and no other seated visit holds them.
 */
async function releaseTablesForToken(
  supabaseAdmin,
  token,
  restaurantId,
  { queueFeedback = false, feedbackSource = 'token-complete' } = {},
) {
  const tableIds = await resolveTokenTableIds(supabaseAdmin, token, restaurantId);
  const freed = [];

  for (const tableId of tableIds) {
    if (await tableHasActiveOrders(supabaseAdmin, tableId)) continue;

    const { data: tableRow } = await supabaseAdmin
      .from('tables')
      .select('id, table_number, status')
      .eq('id', tableId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!tableRow || tableRow.status === 'available') continue;

    const otherSeated = await findSeatedTokenHoldingTable(
      supabaseAdmin,
      tableId,
      tableRow.table_number,
      restaurantId,
    );
    if (otherSeated && otherSeated !== token.id) continue;

    await supabaseAdmin
      .from('tables')
      .update({ status: 'available' })
      .eq('id', tableId)
      .eq('restaurant_id', restaurantId);

    freed.push(tableId);

    if (queueFeedback && tableId === token.table_id && token.phone) {
      await queueFeedbackForTable({
        tableId,
        customerPhone: token.phone,
        customerName:  token.name,
        tokenId:       token.id,
        restaurantId,
        source:        feedbackSource,
      }).catch(e => console.error('[table-release] feedback queue failed:', e.message));
    }
  }

  return freed;
}

/**
 * Occupied tables with no seated visit and no active orders (e.g. bulk combo leftovers).
 */
async function releaseOrphanedOccupiedTables(supabaseAdmin, restaurantId) {
  const { data: occupied } = await supabaseAdmin
    .from('tables')
    .select('id, table_number')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'occupied');

  const freed = [];
  for (const table of occupied ?? []) {
    const holder = await findSeatedTokenHoldingTable(
      supabaseAdmin,
      table.id,
      table.table_number,
      restaurantId,
    );
    if (holder) continue;
    if (await tableHasActiveOrders(supabaseAdmin, table.id)) continue;

    await supabaseAdmin
      .from('tables')
      .update({ status: 'available' })
      .eq('id', table.id)
      .eq('restaurant_id', restaurantId);

    freed.push(table.table_number);
  }
  return freed;
}

module.exports = {
  resolveTokenTableIds,
  releaseTablesForToken,
  releaseOrphanedOccupiedTables,
  ACTIVE_ORDER_STATUSES,
};
