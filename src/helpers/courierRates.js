/**
 * Custom courier rate card: zone from pincodes + charge from weight slabs.
 * Zones mirror typical Indian courier cards:
 *   local | within_state | metro | rest_of_india | special
 */

const COURIER_ZONES = ['local', 'within_state', 'metro', 'rest_of_india', 'special'];

const DEFAULT_WEIGHT_SLABS_KG = [0.5, 1, 2, 5];

/** First-2 PIN digits → coarse Indian state / circle key */
const PIN2_STATE = {
  11: 'DL',
  12: 'HR', 13: 'HR',
  14: 'PB', 15: 'PB', 16: 'PB',
  17: 'HP',
  18: 'JK', 19: 'JK',
  20: 'UP', 21: 'UP', 22: 'UP', 23: 'UP', 24: 'UP', 25: 'UP', 26: 'UP', 27: 'UP', 28: 'UP',
  30: 'RJ', 31: 'RJ', 32: 'RJ', 33: 'RJ', 34: 'RJ',
  36: 'GJ', 37: 'GJ', 38: 'GJ', 39: 'GJ',
  40: 'MH', 41: 'MH', 42: 'MH', 43: 'MH', 44: 'MH',
  45: 'MP', 46: 'MP', 47: 'MP', 48: 'MP',
  49: 'CT',
  50: 'TG', 51: 'AP', 52: 'AP', 53: 'AP',
  56: 'KA', 57: 'KA', 58: 'KA', 59: 'KA',
  60: 'TN', 61: 'TN', 62: 'TN', 63: 'TN', 64: 'TN',
  67: 'KL', 68: 'KL', 69: 'KL',
  70: 'WB', 71: 'WB', 72: 'WB', 73: 'WB', 74: 'WB',
  75: 'OR', 76: 'OR', 77: 'OR',
  78: 'AS',
  79: 'NE',
  80: 'BR', 81: 'BR', 82: 'BR', 83: 'JH', 84: 'BR', 85: 'BR',
  90: 'MP', 91: 'MP', 92: 'MP',
};

/** Sorting-district prefixes treated as metro hubs */
const METRO_PREFIX3 = new Set([
  '110', // Delhi
  '400', '401', // Mumbai
  '560', // Bengaluru
  '600', // Chennai
  '700', // Kolkata
  '500', // Hyderabad
  '411', // Pune
  '380', // Ahmedabad
]);

/** Destinations that typically attract special / remote rates */
const SPECIAL_PIN2 = new Set(['18', '19', '78', '79']);
const SPECIAL_PIN3 = new Set(['744', '682']); // Andaman / Lakshadweep-ish

function normalizePincode(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 6 ? digits.slice(0, 6) : '';
}

function pinState(pin) {
  const p = normalizePincode(pin);
  if (!p) return '';
  return PIN2_STATE[Number(p.slice(0, 2))] || '';
}

function isMetroPin(pin) {
  const p = normalizePincode(pin);
  return !!p && METRO_PREFIX3.has(p.slice(0, 3));
}

function isSpecialPin(pin) {
  const p = normalizePincode(pin);
  if (!p) return false;
  if (SPECIAL_PIN3.has(p.slice(0, 3))) return true;
  return SPECIAL_PIN2.has(p.slice(0, 2));
}

function isSameCityPincode(tenantPincode, customerPincode) {
  const tenant = normalizePincode(tenantPincode);
  const customer = normalizePincode(customerPincode);
  if (!tenant || !customer) return false;
  if (tenant === customer) return true;
  return tenant.slice(0, 3) === customer.slice(0, 3);
}

/**
 * Resolve courier zone for origin → destination pincodes.
 */
function resolveCourierZone(originPin, destPin) {
  const origin = normalizePincode(originPin);
  const dest = normalizePincode(destPin);
  if (!origin || !dest) return 'rest_of_india';

  if (isSameCityPincode(origin, dest)) return 'local';
  if (isSpecialPin(dest)) return 'special';

  const oState = pinState(origin);
  const dState = pinState(dest);
  if (oState && dState && oState === dState) return 'within_state';

  if (isMetroPin(origin) && isMetroPin(dest)) return 'metro';

  return 'rest_of_india';
}

function emptyRateCard() {
  const rates = {};
  for (const slab of DEFAULT_WEIGHT_SLABS_KG) {
    const key = String(slab);
    rates[key] = {};
    for (const z of COURIER_ZONES) rates[key][z] = '';
  }
  const additional_per_kg = {};
  for (const z of COURIER_ZONES) additional_per_kg[z] = '';
  return {
    weight_slabs_kg: [...DEFAULT_WEIGHT_SLABS_KG],
    rates,
    additional_per_kg,
  };
}

function normalizeRateCard(raw) {
  const base = emptyRateCard();
  if (!raw || typeof raw !== 'object') return base;

  const slabs = Array.isArray(raw.weight_slabs_kg)
    ? raw.weight_slabs_kg.map((n) => Number(n)).filter((n) => n > 0).sort((a, b) => a - b)
    : base.weight_slabs_kg;
  const weight_slabs_kg = slabs.length ? slabs : base.weight_slabs_kg;

  const rates = {};
  for (const slab of weight_slabs_kg) {
    const key = String(slab);
    const src = (raw.rates && (raw.rates[key] || raw.rates[slab])) || {};
    rates[key] = {};
    for (const z of COURIER_ZONES) {
      const v = Number(src[z]);
      rates[key][z] = Number.isFinite(v) && v >= 0 ? v : null;
    }
  }

  const additional_per_kg = {};
  const addSrc = raw.additional_per_kg || {};
  for (const z of COURIER_ZONES) {
    const v = Number(addSrc[z]);
    additional_per_kg[z] = Number.isFinite(v) && v >= 0 ? v : null;
  }

  return { weight_slabs_kg, rates, additional_per_kg };
}

/**
 * Look up ₹ charge for weightKg in zone from a normalized rate card.
 * Uses the first slab that covers the weight; above the top slab adds additional_per_kg.
 */
function chargeFromRateCard(rateCard, zone, weightKg) {
  const card = normalizeRateCard(rateCard);
  const z = COURIER_ZONES.includes(zone) ? zone : 'rest_of_india';
  const w = Math.max(0.01, Number(weightKg) || 0.5);
  const slabs = card.weight_slabs_kg;

  let slab = slabs.find((s) => w <= s);
  let overKg = 0;
  if (!slab) {
    slab = slabs[slabs.length - 1];
    overKg = Math.max(0, w - slab);
  }

  const base = card.rates[String(slab)]?.[z];
  if (base == null || !Number.isFinite(base)) return null;

  const add = card.additional_per_kg[z];
  const extra = overKg > 0 && add != null ? overKg * add : 0;
  return Math.round((base + extra) * 100) / 100;
}

function normalizeShippingProvider(value) {
  const v = String(value || 'shiprocket').toLowerCase().trim();
  return v === 'custom' ? 'custom' : 'shiprocket';
}

module.exports = {
  COURIER_ZONES,
  DEFAULT_WEIGHT_SLABS_KG,
  normalizePincode,
  isSameCityPincode,
  resolveCourierZone,
  emptyRateCard,
  normalizeRateCard,
  chargeFromRateCard,
  normalizeShippingProvider,
};
