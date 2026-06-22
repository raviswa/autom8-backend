// Auto-assign dine-in tables / auto-approve large parties when managers
// haven't acted within a short grace period (default 2–4 minutes).

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { broadcastToRestaurant } = require('../websocket');
const {
  sendWhatsAppMessage,
  sendWhatsAppCatalogWithSpecials,
  isWhatsAppConfigured,
} = require('./whatsapp');
const { syncConversationForTokenApproval } = require('./conversationState');

function isEnabled() {
  return process.env.DINEIN_AUTO_ASSIGN_ENABLED !== 'false';
}

function hashTokenId(tokenId) {
  let h = 0;
  const s = String(tokenId || '');
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/** Per-token delay in [min, max] minutes (default 2–4). */
function autoAssignDelayMs(tokenId) {
  const minM = Math.max(1, parseInt(process.env.DINEIN_AUTO_ASSIGN_MIN_MINUTES || '2', 10));
  const maxM = Math.max(minM, parseInt(process.env.DINEIN_AUTO_ASSIGN_MAX_MINUTES || '4', 10));
  if (minM === maxM) return minM * 60 * 1000;
  const span = maxM - minM + 1;
  return (minM + (hashTokenId(tokenId) % span)) * 60 * 1000;
}

function tokenReadyForAutoAssign(token) {
  if (!token?.arrived_at) return false;
  const arrivedMs = new Date(token.arrived_at).getTime();
  if (!Number.isFinite(arrivedMs)) return false;
  return Date.now() - arrivedMs >= autoAssignDelayMs(token.id);
}

async function fetchAvailableTables(restaurantId) {
  const { data, error } = await supabaseAdmin
    .from('tables')
    .select('id, table_number, capacity, status, section')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'available')
    .eq('is_active', true)
    .order('capacity', { ascending: true });

  if (error) throw error;
  return (data ?? []).filter((t) => Number(t.capacity) > 0);
}

/** Smallest available table that fits the party. */
function pickSingleTable(tables, pax) {
  const party = Math.max(1, parseInt(pax, 10) || 1);
  return tables.find((t) => Number(t.capacity) >= party) ?? null;
}

/** Greedy multi-table combo (largest tables first), same strategy as chat agent. */
function pickTableCombo(tables, pax) {
  const party = Math.max(1, parseInt(pax, 10) || 1);
  const sorted = [...tables].sort((a, b) => Number(b.capacity) - Number(a.capacity));
  const combo = [];
  let remaining = party;

  for (const t of sorted) {
    if (remaining <= 0) break;
    const cap = Number(t.capacity);
    const seatsUsed = Math.min(cap, remaining);
    combo.push([t.table_number, cap, seatsUsed]);
    remaining -= seatsUsed;
  }

  if (remaining > 0) return null;
  return combo;
}

function comboStillAvailable(tablesByNumber, combo) {
  if (!Array.isArray(combo) || !combo.length) return false;
  for (const row of combo) {
    const num = String(row[0]);
    const table = tablesByNumber.get(num);
    if (!table || table.status !== 'available') return false;
  }
  return true;
}

async function notifyCustomerSeated(token, restaurantId, tableNumbers, messagePrefix) {
  if (!token.phone || !(await isWhatsAppConfigured(restaurantId))) {
    console.warn(
      `[dine-in-auto] Skip WA notify for ${token.id} — missing phone or credentials`,
    );
    return { catalogOk: false, pickerSent: false, specialsSent: false, mechanism: 'none' };
  }

  const tablesLabel = tableNumbers.length === 1
    ? `Table ${tableNumbers[0]}`
    : `Tables ${tableNumbers.join(', ')}`;

  const body = messagePrefix
    ?? `✅ *Your table is ready!*\n\nToken: *${token.id}*\nTable: *${tablesLabel}*\n\nPlease proceed to your table. Enjoy! 🍽️`;

  await sendWhatsAppMessage(token.phone, body, restaurantId);
  // Brief pause — back-to-back text + interactive often fails on Meta.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const menuSendResult = await sendWhatsAppCatalogWithSpecials(token.phone, restaurantId);
  if (!menuSendResult.catalogOk && !menuSendResult.pickerSent) {
    console.error(
      `[dine-in-auto] Menu send failed after seating ${token.id} → ${token.phone}`,
    );
  }
  return menuSendResult;
}

async function autoAssignDineInToken(token, restaurantId, table) {
  const meta = { ...(token.meta || {}), auto_assigned_at: new Date().toISOString() };

  const { data: updatedToken, error } = await supabaseAdmin
    .from('walk_in_tokens')
    .update({
      status: 'seated',
      table_id: table.id,
      table_number: table.table_number,
      seated_at: new Date().toISOString(),
      meta,
    })
    .eq('id', token.id)
    .eq('restaurant_id', restaurantId)
    .eq('status', 'waiting')
    .eq('type', 'dinein')
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!updatedToken) return false;

  await supabaseAdmin
    .from('tables')
    .update({
      status: 'occupied',
      seated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', table.id)
    .eq('restaurant_id', restaurantId);

  const menuSendResult = await notifyCustomerSeated(
    token,
    restaurantId,
    [String(table.table_number)],
  );

  await syncConversationForTokenApproval({
    restaurantId,
    customerPhone: token.phone,
    tokenId: token.id,
    tableNumbers: [String(table.table_number)],
    partySize: token.pax,
    specialsNoteSent: menuSendResult.specialsSent,
    menuSendResult,
  });

  broadcastToRestaurant(restaurantId, {
    type: 'TOKEN_ASSIGNED',
    token: updatedToken,
    timestamp: new Date().toISOString(),
    auto_assigned: true,
  });

  console.log(
    `[dine-in-auto] Assigned ${token.id} → Table ${table.table_number} ` +
    `(restaurant ${restaurantId})`,
  );
  return true;
}

async function autoApproveLargePartyToken(token, restaurantId, combo, tablesByNumber) {
  const tableNumbers = combo.map((row) => String(row[0]));
  const tableIds = tableNumbers
    .map((n) => tablesByNumber.get(n)?.id)
    .filter(Boolean);

  if (tableIds.length !== tableNumbers.length) return false;

  const meta = {
    ...(token.meta || {}),
    combo,
    approved_at: new Date().toISOString(),
    auto_assigned_at: new Date().toISOString(),
    table_ids: tableIds,
    table_numbers: tableNumbers,
  };

  const { data: updatedToken, error } = await supabaseAdmin
    .from('walk_in_tokens')
    .update({
      status: 'seated',
      table_id: tableIds[0] ?? null,
      table_number: tableNumbers[0] ?? null,
      seated_at: new Date().toISOString(),
      meta,
    })
    .eq('id', token.id)
    .eq('restaurant_id', restaurantId)
    .eq('status', 'pending_approval')
    .eq('type', 'large_party')
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!updatedToken) return false;

  if (tableIds.length) {
    await supabaseAdmin
      .from('tables')
      .update({
        status: 'occupied',
        seated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .in('id', tableIds)
      .eq('restaurant_id', restaurantId);
  }

  const menuSendResult = await notifyCustomerSeated(
    token,
    restaurantId,
    tableNumbers,
    `✅ *Your table arrangement has been confirmed.*\n\nToken: *${token.id}*\n`
    + `Party of: *${token.pax} people*\nTables: *${tableNumbers.join(', ')}*\n\n`
    + `Please head to the restaurant! 🍽️`,
  );

  await syncConversationForTokenApproval({
    restaurantId,
    customerPhone: token.phone,
    tokenId: token.id,
    tableNumbers,
    partySize: token.pax,
    specialsNoteSent: menuSendResult.specialsSent,
    menuSendResult,
  });

  broadcastToRestaurant(restaurantId, {
    type: 'TOKEN_APPROVED',
    token: updatedToken,
    timestamp: new Date().toISOString(),
    auto_assigned: true,
  });

  console.log(
    `[dine-in-auto] Approved large party ${token.id} → Tables ${tableNumbers.join(', ')} ` +
    `(restaurant ${restaurantId})`,
  );
  return true;
}

async function processToken(token) {
  if (!tokenReadyForAutoAssign(token)) return;

  const restaurantId = token.restaurant_id;
  const tables = await fetchAvailableTables(restaurantId);
  if (!tables.length) return;

  if (token.type === 'dinein' && token.status === 'waiting') {
    const table = pickSingleTable(tables, token.pax);
    if (!table) return;
    await autoAssignDineInToken(token, restaurantId, table);
    return;
  }

  if (token.type === 'large_party' && token.status === 'pending_approval') {
    const combo = token.meta?.combo;
    const tablesByNumber = new Map(tables.map((t) => [String(t.table_number), t]));

    if (comboStillAvailable(tablesByNumber, combo)) {
      await autoApproveLargePartyToken(token, restaurantId, combo, tablesByNumber);
      return;
    }

    // Proposed combo no longer free — try a fresh combo if capacity allows.
    const freshCombo = pickTableCombo(tables, token.pax);
    if (!freshCombo) return;

    const freshByNumber = new Map(tables.map((t) => [String(t.table_number), t]));
    if (!comboStillAvailable(freshByNumber, freshCombo)) return;
    await autoApproveLargePartyToken(token, restaurantId, freshCombo, freshByNumber);
  }
}

async function runDineInAutoAssignJob() {
  if (!isEnabled()) return;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: tokens, error } = await supabaseAdmin
    .from('walk_in_tokens')
    .select('*')
    .gte('arrived_at', todayStart.toISOString())
    .in('type', ['dinein', 'large_party'])
    .in('status', ['waiting', 'pending_approval'])
    .order('arrived_at', { ascending: true })
    .limit(50);

  if (error) {
    console.error('[dine-in-auto] Query failed:', error.message);
    return;
  }

  for (const token of tokens ?? []) {
    try {
      await processToken(token);
    } catch (err) {
      console.error(`[dine-in-auto] Failed for ${token.id}:`, err.message);
    }
  }
}

module.exports = {
  runDineInAutoAssignJob,
  autoAssignDelayMs,
  pickSingleTable,
  pickTableCombo,
};
