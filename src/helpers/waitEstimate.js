'use strict';

/**
 * Static walk-in wait estimate at token issuance.
 * See product spec: wave algorithm with tiered dropout.
 */

const DEFAULT_DINING_MINUTES = 45;
const TURNOVER_MINUTES = 5;
const MIN_REMAINING_FLOOR = 5;
const RANGE_BUFFER = 10;

function dropoutRate(partySize) {
  const p = Math.max(1, parseInt(partySize, 10) || 1);
  if (p >= 5) return 0.35;
  if (p >= 3) return 0.20;
  return 0.15;
}

function formatWaitDisplay(low, high, estimateMinutes) {
  if (estimateMinutes === 0) return 'Ready to seat now';
  if (estimateMinutes < 0) return 'No suitable table available';
  if (low < 15) return 'Less than 15 minutes';
  if (low < 30) return 'Around 20–30 minutes';
  return `Approximately ${low}–${high} minutes`;
}

function todayStartUtc() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function minutesBetween(startIso, endDate = new Date()) {
  const start = new Date(startIso).getTime();
  const end = endDate.getTime();
  if (Number.isNaN(start)) return 0;
  return Math.max(0, Math.floor((end - start) / 60000));
}

/**
 * Earliest dining start for a table today: first order/KOT, else seated_at, else updated_at.
 */
async function getTableDiningStart(supabaseAdmin, restaurantId, tableId) {
  const dayStart = todayStartUtc();

  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('id, created_at')
    .eq('restaurant_id', restaurantId)
    .eq('table_id', tableId)
    .gte('created_at', dayStart)
    .order('created_at', { ascending: true })
    .limit(1);

  if (orders?.length) {
    return orders[0].created_at;
  }

  const { data: table } = await supabaseAdmin
    .from('tables')
    .select('seated_at, updated_at')
    .eq('id', tableId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle();

  return table?.seated_at || table?.updated_at || null;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {string} restaurantId
 * @param {number} partySize
 * @param {string} tokenArrivedAt ISO timestamp of this token
 * @param {string} [tokenId] exclude self from ahead count
 */
async function calculateWaitEstimate(
  supabaseAdmin,
  restaurantId,
  partySize,
  tokenArrivedAt,
  tokenId = null,
) {
  const pax = Math.max(1, parseInt(partySize, 10) || 1);
  const now = new Date();

  const { data: restaurant } = await supabaseAdmin
    .from('tenants')
    .select('dining_duration_minutes')
    .eq('id', restaurantId)
    .maybeSingle();

  const diningMinutes = restaurant?.dining_duration_minutes > 0
    ? restaurant.dining_duration_minutes
    : DEFAULT_DINING_MINUTES;

  const { data: allTables } = await supabaseAdmin
    .from('tables')
    .select('id, capacity, status, is_active')
    .eq('restaurant_id', restaurantId)
    .eq('is_active', true);

  const eligible = (allTables ?? []).filter(
    (t) => (t.capacity ?? 4) >= pax,
  );

  if (eligible.length === 0) {
    return {
      estimate_minutes: -1,
      low: 0,
      high: 0,
      display: formatWaitDisplay(0, 0, -1),
      waitlist_depth: 0,
    };
  }

  const free = eligible.filter((t) => {
    const st = (t.status || 'available').toLowerCase();
    return st === 'available' || st === 'free';
  });

  if (free.length > 0) {
    return {
      estimate_minutes: 0,
      low: 0,
      high: 0,
      display: formatWaitDisplay(0, 0, 0),
      waitlist_depth: 0,
    };
  }

  const occupied = eligible.filter((t) => (t.status || '').toLowerCase() === 'occupied');

  const remaining = [];
  for (const table of occupied) {
    const startedAt = await getTableDiningStart(supabaseAdmin, restaurantId, table.id);
    const elapsed = startedAt ? minutesBetween(startedAt, now) : diningMinutes;
    remaining.push(Math.max(MIN_REMAINING_FLOOR, diningMinutes - elapsed));
  }

  remaining.sort((a, b) => a - b);

  const dayStart = todayStartUtc();
  let aheadQuery = supabaseAdmin
    .from('walk_in_tokens')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId)
    .eq('status', 'waiting')
    .eq('type', 'dinein')
    .lte('pax', pax)
    .gte('arrived_at', dayStart)
    .lt('arrived_at', tokenArrivedAt);

  if (tokenId) {
    aheadQuery = aheadQuery.neq('id', tokenId);
  }

  const { count: waitlistDepth } = await aheadQuery;
  const W = waitlistDepth ?? 0;

  const rate = dropoutRate(pax);
  const effectiveW = Math.floor(W * (1 - rate));

  if (occupied.length === 0) {
    const estimateMin = diningMinutes + TURNOVER_MINUTES;
    const low = Math.max(5, estimateMin - RANGE_BUFFER);
    const high = estimateMin + RANGE_BUFFER;
    return {
      estimate_minutes: estimateMin,
      low,
      high,
      display: formatWaitDisplay(low, high, estimateMin),
      waitlist_depth: W,
    };
  }

  const nTables = occupied.length;
  const myPosition = effectiveW;
  const wave = Math.floor(myPosition / nTables);
  const tableIndex = myPosition % nTables;
  const baseWait = remaining[tableIndex] ?? remaining[remaining.length - 1];
  const extraWaves = wave * diningMinutes;
  const estimateMin = baseWait + extraWaves + TURNOVER_MINUTES;

  const low = Math.max(5, estimateMin - RANGE_BUFFER);
  const high = estimateMin + RANGE_BUFFER;

  return {
    estimate_minutes: estimateMin,
    low,
    high,
    display: formatWaitDisplay(low, high, estimateMin),
    waitlist_depth: W,
  };
}

function buildDineInCustomerMessage(partySize, tokenId, estimate) {
  const pax = Math.max(1, parseInt(partySize, 10) || 1);
  const people = `${pax} ${pax === 1 ? 'person' : 'people'}`;

  if (estimate.estimate_minutes === 0) {
    return (
      `Your token is *${tokenId}* 🎟\n`
      + `Party of ${people}\n`
      + `*Your table is ready — please approach the host.*`
    );
  }

  if (estimate.estimate_minutes < 0) {
    return (
      `Party of *${pax}* — we've noted your visit! 🍽️\n\n`
      + `*Token: ${tokenId}*\n\n`
      + `Our team will assist you shortly — please speak with the host. 🙏`
    );
  }

  return (
    `Your token is *${tokenId}* 🎟\n`
    + `Party of ${people} · *${estimate.display}*\n`
    + `We'll notify you when your table is ready.`
  );
}

module.exports = {
  calculateWaitEstimate,
  formatWaitDisplay,
  buildDineInCustomerMessage,
  DEFAULT_DINING_MINUTES,
};
