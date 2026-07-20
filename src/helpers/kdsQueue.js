'use strict';

/** Stations that route to the packing display (not the hot kitchen). */
const PACKING_STATIONS = new Set(['sweets_counter', 'packing', 'dispatch']);

/** LOBs with no live kitchen — all tickets go to the packing queue. */
const PACKAGED_LOBS = new Set(['food_products', 'retail', 'b2b', 'psl']);

function isPackagedLob(lobType) {
  return PACKAGED_LOBS.has(String(lobType || '').toLowerCase());
}

/**
 * Classify a kitchen_station (+ optional tenant lob) into cooking vs packing queue.
 * Packaged-food / retail / PSL / B2B always pack — makers batch by SKU, not cook.
 */
function queueForStation(station, lobType = null) {
  if (isPackagedLob(lobType)) return 'packing';
  const s = String(station || '').toLowerCase().trim();
  return PACKING_STATIONS.has(s) ? 'packing' : 'cooking';
}

module.exports = {
  PACKING_STATIONS,
  PACKAGED_LOBS,
  isPackagedLob,
  queueForStation,
};
