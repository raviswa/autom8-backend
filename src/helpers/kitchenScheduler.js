'use strict';

/**
 * Kitchen scheduling — mirrors chat/tools/kitchen_scheduler.py
 */

const IST = 'Asia/Kolkata';

const KITCHEN_STATIONS = new Set(['tawa', 'steamer', 'kadai', 'beverages', 'assembly', 'cold']);
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
    const cook = effectiveCookTime(m, qty);
    stationTimes[m.kitchen_station] = (stationTimes[m.kitchen_station] || 0) + cook;
    packingTotal += m.packing_time * qty;
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

function roundDownToBoundary(instant, boundaryMinutes) {
  const p = istParts(instant);
  const rem = p.minute % boundaryMinutes;
  const minute = p.minute - rem;
  const pad = (n) => String(n).padStart(2, '0');
  return new Date(`${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(minute)}:00+05:30`);
}

function computeKitchenStartAt(slotAt, {
  serviceType,
  cartLines,
  menuByRetailerId,
  bufferMinutes = 15,
  roundingMinutes = 15,
  transitMinutes = 0,
}) {
  const timing = computeOrderTiming(cartLines, menuByRetailerId);
  const st = String(serviceType || '').replace(/-/g, '_').toLowerCase();
  const packing = ['takeaway', 'delivery'].includes(st) ? timing.total_packing_minutes : 0;
  const totalLead = transitMinutes + timing.total_cook_minutes + packing + bufferMinutes;
  const rawStart = new Date(new Date(slotAt).getTime() - totalLead * 60 * 1000);
  const kitchenStart = roundDownToBoundary(rawStart, Math.max(1, roundingMinutes));
  return {
    kitchen_start_at: kitchenStart.toISOString(),
    scheduled_slot_at: new Date(slotAt).toISOString(),
    total_cook_minutes: timing.total_cook_minutes,
    total_packing_minutes: packing,
    transit_minutes: transitMinutes,
    buffer_minutes: bufferMinutes,
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
  computeKitchenStartAt,
  computeOrderTiming,
  effectiveCookTime,
  cartLinesFromItems,
  MENU_DEFAULTS,
  KITCHEN_STATIONS,
};
