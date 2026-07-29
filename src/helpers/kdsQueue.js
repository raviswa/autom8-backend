'use strict';

/** Stations that route to the packing display (not the hot kitchen). */
const PACKING_STATIONS = new Set(['sweets_counter', 'packing', 'dispatch']);

/** Allowed kitchen_station values (catalog upload + DB). */
const KITCHEN_STATIONS = new Set([
  'tawa', 'steamer', 'kadai', 'beverages', 'assembly', 'cold',
  'sweets_counter', 'packing', 'dispatch',
]);

/** Common typos / informal labels → packing station (not assembly/cooking). */
const PACKING_STATION_ALIASES = Object.freeze({
  savory: 'sweets_counter',
  savouries: 'sweets_counter',
  savories: 'sweets_counter',
  readymade: 'sweets_counter',
  'ready-made': 'sweets_counter',
  ready_made: 'sweets_counter',
  'ready made': 'sweets_counter',
  counter: 'sweets_counter',
  sweets: 'sweets_counter',
  sweet: 'sweets_counter',
  mithai: 'sweets_counter',
  namkeen: 'sweets_counter',
  pack: 'packing',
});

/** LOBs with no live kitchen — all tickets go to the packing queue. */
const PACKAGED_LOBS = new Set(['food_products', 'retail', 'b2b', 'psl']);

/** Categories that mean pre-packed / counter items when kitchen_station is blank. */
const READYMADE_CATEGORY_RE =
  /sweet|savor|savour|readymade|ready[\s_-]?made|mithai|namkeen|bakery|pre[\s_-]?pack|confection/i;

function isPackagedLob(lobType) {
  return PACKAGED_LOBS.has(String(lobType || '').toLowerCase());
}

function isReadymadeCategory(category) {
  return READYMADE_CATEGORY_RE.test(String(category || '').trim());
}

/**
 * Normalize a raw kitchen_station (+ optional category) for menu rows and KDS.
 * Blank sweets/savories/readymade categories → sweets_counter (packing).
 * Aliases like "savory" / "readymade" → sweets_counter (not assembly).
 * Readymade categories also override legacy default `assembly` (hot stations like
 * tawa/steamer/kadai still win when explicitly set).
 */
function resolveKitchenStation(rawStation, opts = {}) {
  const { category = null, packagedLob = false } = opts;
  if (packagedLob || isPackagedLob(opts.lobType)) return 'sweets_counter';

  const raw = String(rawStation || '').toLowerCase().trim();
  let resolved = null;
  if (raw) {
    if (PACKING_STATION_ALIASES[raw]) resolved = PACKING_STATION_ALIASES[raw];
    else if (KITCHEN_STATIONS.has(raw)) resolved = raw;
  }

  if (isReadymadeCategory(category) && (!resolved || resolved === 'assembly')) {
    return 'sweets_counter';
  }

  return resolved || 'assembly';
}

/** @deprecated Prefer resolveKitchenStation — kept for uploadParse callers. */
function parseKitchenStation(raw) {
  return resolveKitchenStation(raw);
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
  KITCHEN_STATIONS,
  PACKING_STATION_ALIASES,
  isPackagedLob,
  isReadymadeCategory,
  resolveKitchenStation,
  parseKitchenStation,
  queueForStation,
};
