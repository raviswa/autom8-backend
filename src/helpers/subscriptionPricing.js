'use strict';

/**
 * Per-capability subscription pricing.
 * Primary packaged (or b2b-only) LOB = ₹500.
 * Supply add-on on top of a non-b2b primary = +₹500.
 */

const LOB_PRICE_INR = 500;
/** @deprecated Use calculateMonthlyPrice(tenant) — kept for callers that need a fallback scalar. */
const MONTHLY_PRICE_INR = LOB_PRICE_INR;

const PACKAGED_CATALOG_LOBS = new Set([
  'restaurant',
  'food_products',
  'retail',
  'cloud_kitchen',
  'psl',
  'jewellery',
]);

const SUPPLY_IMPLIED_LOBS = new Set(['b2b', 'supply', 'b2b_supply']);

function normalizeLob(value) {
  return String(value || '').trim().toLowerCase();
}

function isSupplyImplied(tenantOrLob) {
  if (tenantOrLob && typeof tenantOrLob === 'object') {
    return SUPPLY_IMPLIED_LOBS.has(normalizeLob(tenantOrLob.lob_type));
  }
  return SUPPLY_IMPLIED_LOBS.has(normalizeLob(tenantOrLob));
}

function isSupplyOptedIn(tenant) {
  if (!tenant) return false;
  if (isSupplyImplied(tenant)) return true;
  return tenant.supply_enabled === true || tenant.supply_enabled === 'true' || tenant.supply_enabled === 1;
}

/**
 * ₹500 × active capabilities.
 * b2b alone = 1; retail + supply_enabled = 2; retail alone = 1.
 */
function calculateMonthlyPrice(tenant) {
  let count = 1;
  if (tenant?.supply_enabled && !isSupplyImplied(tenant)) count += 1;
  return count * LOB_PRICE_INR;
}

/**
 * Guard against multi packaged-catalog LOB selection in one request.
 * Accepts business_verticals[], lob_types[], or singular fields.
 * Throws Error with status 400 and named conflict message.
 */
function assertSinglePackagedCatalogLob(body = {}) {
  const candidates = [];
  const push = (raw) => {
    const n = normalizeLob(raw);
    if (!n) return;
    // supply/b2b are not packaged-catalog conflicts
    if (SUPPLY_IMPLIED_LOBS.has(n) || n === 'supply_enabled') return;
    // jewellery may arrive as retail alias later — still treat explicit jewellery as packaged
    if (PACKAGED_CATALOG_LOBS.has(n)) candidates.push(n);
  };

  if (Array.isArray(body.business_verticals)) {
    for (const v of body.business_verticals) push(v);
  }
  if (Array.isArray(body.lob_types)) {
    for (const v of body.lob_types) push(v);
  }
  if (Array.isArray(body.lobs)) {
    for (const v of body.lobs) push(v);
  }
  // Singular fields — only conflict when multi-array already collected distinct packaged
  push(body.lob_type);
  push(body.org_type);
  push(body.business_type);
  // business_vertical ids often equal lob_type for packaged set
  push(body.business_vertical);

  const unique = [...new Set(candidates)];
  if (unique.length > 1) {
    const err = new Error(
      `${unique[0]} and ${unique[1]} cannot both be selected`,
    );
    err.status = 400;
    err.code = 'lob_conflict';
    err.conflicting = unique;
    throw err;
  }
  return unique[0] || null;
}

function parseSupplyEnabledFlag(body = {}, lobType = null) {
  if (isSupplyImplied(lobType)) return true;
  const raw = body.supply_enabled;
  if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false;
  // business_verticals may include 'supply' / 'b2b' as add-on alongside a primary
  const lists = []
    .concat(Array.isArray(body.business_verticals) ? body.business_verticals : [])
    .concat(Array.isArray(body.lobs) ? body.lobs : [])
    .concat(Array.isArray(body.lob_types) ? body.lob_types : [])
    .map(normalizeLob);
  if (lists.some((v) => SUPPLY_IMPLIED_LOBS.has(v) || v === 'supply_addon' || v === 'b2b_supply')) {
    return true;
  }
  return false;
}

module.exports = {
  LOB_PRICE_INR,
  MONTHLY_PRICE_INR,
  PACKAGED_CATALOG_LOBS,
  SUPPLY_IMPLIED_LOBS,
  normalizeLob,
  isSupplyImplied,
  isSupplyOptedIn,
  calculateMonthlyPrice,
  assertSinglePackagedCatalogLob,
  parseSupplyEnabledFlag,
};
