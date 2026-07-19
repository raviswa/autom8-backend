'use strict';

/**
 * Kitchen scheduling — mirrors chat/tools/kitchen_scheduler.py
 */

const IST = 'Asia/Kolkata';

const TAKEAWAY_ROUNDING_MINUTES = 30;
const DELIVERY_ROUNDING_MINUTES = 15;

const KITCHEN_STATIONS = new Set(['tawa', 'steamer', 'kadai', 'beverages', 'assembly', 'cold', 'sweets_counter']);
const PACKING_STATIONS = new Set(['sweets_counter']);
const MENU_DEFAULTS = {
  prep_time_fixed: 5,
  batch_size: 1,
  time_per_batch: 10,
  kitchen_station: 'assembly',
  packing_time: 1.0,
  holds_well: false,
};

function menuLine(item) {
  const src = item || {};
  let station = String(src.kitchen_station || MENU_DEFAULTS.kitchen_station).toLowerCase();
  if (!KITCHEN_STATIONS.has(station)) station = MENU_DEFAULTS.kitchen_station;
  return {
    prep_time_fixed: parseInt(src.prep_time_fixed ?? MENU_DEFAULTS.prep_time_fixed, 10),
    batch_size: Math.max(1, parseInt(src.batch_size ?? MENU_DEFAULTS.batch_size, 10)),
    time_per_batch: Math.max(1, parseInt(src.time_per_batch ?? MENU_DEFAULTS.time_per_batch, 10)),
    kitchen_station: station,
    packing_time: parseFloat(src.packing_time ?? MENU_DEFAULTS.packing_time),
    holds_well: Boolean(src.holds_well),
  };
}

function effectiveCookTime(item, quantity) {
  const m = menuLine(item);
  const qty = Math.max(1, parseInt(quantity, 10));
  const batches = Math.ceil(qty / m.batch_size);
  return m.prep_time_fixed + batches * m.time_per_batch;
}

function computeOrderTiming(cartLines, menuByRetailerId) {
  const stationTimes = {};
  let packingTotal = 0;
  let allHoldWell = true;

  for (const line of cartLines) {
    const rid = String(line.retailer_id || line.id || '').trim();
    const menuItem = (rid && menuByRetailerId[rid]) || {};
    const m = menuLine(menuItem);
    const qty = Math.max(1, parseInt(line.qty || line.quantity || 1, 10));
    if (!m.holds_well) allHoldWell = false;
    packingTotal += m.packing_time * qty;
    // Pre-packed / sweets_counter: packing time only — do not inflate cook lead time
    if (PACKING_STATIONS.has(m.kitchen_station)) continue;
    const cook = effectiveCookTime(m, qty);
    stationTimes[m.kitchen_station] = (stationTimes[m.kitchen_station] || 0) + cook;
  }

  const stations = Object.values(stationTimes);
  const totalCook = stations.length ? Math.max(...stations) : 0;
  return {
    total_cook_minutes: totalCook,
    total_packing_minutes: Math.round(packingTotal * 100) / 100,
    all_hold_well: allHoldWell,
    station_breakdown: stationTimes,
  };
}

function istParts(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(d);
  const get = (t) => parseInt(parts.find((p) => p.type === t)?.value || '0', 10);
  let hour = get('hour');
  if (hour === 24) hour = 0;
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') };
}

function instantFromIstParts(p, minute, hour = p.hour) {
  const pad = (n) => String(n).padStart(2, '0');
  return new Date(`${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(hour)}:${pad(minute)}:00+05:30`);
}

function roundToNearestBoundary(instant, boundaryMinutes) {
  const boundary = Math.max(1, Number(boundaryMinutes) || 15);
  const p = istParts(instant);
  const totalMin = p.hour * 60 + p.minute;
  const rounded = Math.round(totalMin / boundary) * boundary;
  const dayMinutes = 24 * 60;
  const normalized = ((rounded % dayMinutes) + dayMinutes) % dayMinutes;
  return instantFromIstParts(p, normalized % 60, Math.floor(normalized / 60));
}

function roundDownToBoundary(instant, boundaryMinutes) {
  const p = istParts(instant);
  const rem = p.minute % boundaryMinutes;
  const minute = p.minute - rem;
  return instantFromIstParts(p, minute);
}

function resolveTransitMinutes(serviceType, scheduleMeta = {}) {
  const st = String(serviceType || scheduleMeta.service_type || 'takeaway').toLowerCase();
  if (st !== 'delivery') return 0;
  let transit = Number(scheduleMeta.transit_minutes ?? scheduleMeta.delivery_travel_minutes ?? 0);
  if (!transit) transit = 20;
  return transit;
}

/** IST calendar date YYYY-MM-DD for bucket comparisons. */
function istDateKey(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}

/**
 * Bucket scheduled KDS orders:
 * - future: pickup/delivery slot is on a later calendar day (IST)
 * - todays_future: slot is today, kitchen has not started, not yet on live board
 * - present: kitchen start time has passed, not yet dispatched to live KDS
 * - live: already sent to live KDS (kds_sent_at)
 */
function assignScheduledBucket(order, now = new Date()) {
  if (order.kds_sent_at) return 'live';

  const kitchenStart = order.kitchen_start_at ? new Date(order.kitchen_start_at) : null;
  const msToStart = kitchenStart ? kitchenStart.getTime() - now.getTime() : null;
  if (kitchenStart && msToStart <= 0) return 'present';

  const todayKey = istDateKey(now);
  const slotKey = istDateKey(order.scheduled_slot_at || order.booking_datetime);
  if (slotKey && todayKey && slotKey > todayKey) return 'future';

  return 'todays_future';
}

function estimateKitchenStartFromTotals(slotAt, {
  serviceType,
  totalCookMinutes,
  totalPackingMinutes,
  scheduleMeta = {},
  bufferMinutes = 15,
  takeawayRoundingMinutes = TAKEAWAY_ROUNDING_MINUTES,
}) {
  if (!slotAt) return null;
  const meta = scheduleMeta && typeof scheduleMeta === 'object' ? scheduleMeta : {};
  const cook = Number(totalCookMinutes ?? meta.total_cook_minutes ?? 90);
  const packing = Number(totalPackingMinutes ?? meta.total_packing_minutes ?? 4);
  const buffer = Number(meta.buffer_minutes ?? bufferMinutes ?? 15);
  const takeawayRounding = Number(meta.takeaway_rounding_minutes ?? takeawayRoundingMinutes ?? TAKEAWAY_ROUNDING_MINUTES);
  const st = String(serviceType || meta.service_type || 'takeaway').toLowerCase();
  const transit = resolveTransitMinutes(st, meta);
  const takeawayLead = cook + packing + buffer;
  const slot = new Date(slotAt);
  const rawTakeaway = new Date(slot.getTime() - takeawayLead * 60 * 1000);
  const takeawayStart = roundToNearestBoundary(rawTakeaway, takeawayRounding);

  if (st === 'delivery') {
    const rawDelivery = new Date(takeawayStart.getTime() - transit * 60 * 1000);
    return roundToNearestBoundary(rawDelivery, DELIVERY_ROUNDING_MINUTES);
  }
  return takeawayStart;
}

function computeKitchenStartAt(slotAt, {
  serviceType,
  cartLines,
  menuByRetailerId,
  bufferMinutes = 15,
  roundingMinutes = TAKEAWAY_ROUNDING_MINUTES,
  deliveryRoundingMinutes = DELIVERY_ROUNDING_MINUTES,
  transitMinutes = 0,
}) {
  const timing = computeOrderTiming(cartLines, menuByRetailerId);
  const st = String(serviceType || '').replace(/-/g, '_').toLowerCase();
  const packing = ['takeaway', 'delivery'].includes(st) ? timing.total_packing_minutes : 0;
  const takeawayLead = timing.total_cook_minutes + packing + bufferMinutes;
  const slot = new Date(slotAt);
  const rawTakeaway = new Date(slot.getTime() - takeawayLead * 60 * 1000);
  const takeawayStart = roundToNearestBoundary(rawTakeaway, Math.max(1, roundingMinutes));
  const isDelivery = st === 'delivery';
  const kitchenStart = isDelivery
    ? roundToNearestBoundary(
      new Date(takeawayStart.getTime() - transitMinutes * 60 * 1000),
      Math.max(1, deliveryRoundingMinutes),
    )
    : takeawayStart;
  const boundary = isDelivery ? deliveryRoundingMinutes : roundingMinutes;
  return {
    kitchen_start_at: kitchenStart.toISOString(),
    scheduled_slot_at: slot.toISOString(),
    takeaway_kitchen_start_at: takeawayStart.toISOString(),
    total_cook_minutes: timing.total_cook_minutes,
    total_packing_minutes: packing,
    transit_minutes: isDelivery ? transitMinutes : 0,
    takeaway_lead_minutes: takeawayLead,
    buffer_minutes: bufferMinutes,
    rounding_minutes: boundary,
    all_hold_well: timing.all_hold_well,
    station_breakdown: timing.station_breakdown,
  };
}

function cartLinesFromItems(items = []) {
  return items.map((item) => ({
    retailer_id: item.retailer_id,
    id: item.retailer_id,
    qty: parseInt(item.qty || item.quantity || 1, 10),
    title: item.name,
  }));
}

module.exports = {
  TAKEAWAY_ROUNDING_MINUTES,
  DELIVERY_ROUNDING_MINUTES,
  computeKitchenStartAt,
  computeOrderTiming,
  effectiveCookTime,
  cartLinesFromItems,
  estimateKitchenStartFromTotals,
  roundToNearestBoundary,
  roundDownToBoundary,
  resolveTransitMinutes,
  istDateKey,
  assignScheduledBucket,
  MENU_DEFAULTS,
  KITCHEN_STATIONS,
};
