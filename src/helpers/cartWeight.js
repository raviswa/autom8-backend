'use strict';

/**
 * Resolve parcel weight (grams/kg) from catalog lines.
 * - PRODUCT: weight_grams × qty
 * - BUNDLE: sum(component.weight_grams × component.qty) × line qty when meta.bundle_components set;
 *   otherwise fall back to the bundle row's own weight_grams
 * - packaging_weight_grams on tenant is added once per parcel
 */

function cartWeightKg(items, { packagingGrams = 0 } = {}) {
  let grams = 0;
  let weighed = false;
  for (const line of items || []) {
    const g = Number(line.weight_grams || 0);
    const qty = Math.max(0, Math.floor(Number(line.qty || 0)));
    if (g > 0 && qty > 0) {
      grams += g * qty;
      weighed = true;
    }
  }
  const pack = Math.max(0, Number(packagingGrams) || 0);
  if (pack > 0) {
    grams += pack;
    weighed = true;
  }
  if (!weighed) return 0.5;
  return Math.round((grams / 1000) * 1000) / 1000;
}

/**
 * Build a map of menu rows keyed by id + retailer_id.
 * @param {Array} menuRows
 */
function indexMenuRows(menuRows) {
  const map = new Map();
  for (const row of menuRows || []) {
    if (!row) continue;
    if (row.id != null) map.set(String(row.id), row);
    if (row.retailer_id) map.set(String(row.retailer_id), row);
  }
  return map;
}

function bundleComponentsOf(row) {
  const fromMeta = row?.meta && Array.isArray(row.meta.bundle_components)
    ? row.meta.bundle_components
    : null;
  if (fromMeta && fromMeta.length) return fromMeta;
  return Array.isArray(row?.bundle_components) ? row.bundle_components : [];
}

/**
 * Unit weight in grams for one catalog row (1× of that SKU).
 * Expands BUNDLE components when possible.
 */
function unitWeightGrams(row, menuByKey) {
  if (!row) return 0;
  const type = String(row.item_type || 'PRODUCT').toUpperCase();
  const comps = bundleComponentsOf(row);
  if ((type === 'BUNDLE' || type === 'HAMPER') && comps.length && menuByKey) {
    let sum = 0;
    let any = false;
    for (const c of comps) {
      const child = menuByKey.get(String(c.retailer_id || ''));
      const cg = Number(child?.weight_grams || 0);
      const cq = Math.max(1, parseInt(c.qty, 10) || 1);
      if (cg > 0) {
        sum += cg * cq;
        any = true;
      }
    }
    if (any) return sum;
  }
  return Math.max(0, Number(row.weight_grams || 0) || 0);
}

/**
 * Resolve cart lines against live menu rows and attach effective weight_grams (per unit).
 */
function resolveCartLineWeights(cartItems, menuRows) {
  const menuByKey = indexMenuRows(menuRows);
  const out = [];
  for (const line of cartItems || []) {
    const source = menuByKey.get(String(line.id || ''))
      || menuByKey.get(String(line.retailer_id || ''));
    const qty = Math.max(0, Math.floor(Number(line.qty || 0)));
    if (!qty) continue;
    const unit = source
      ? unitWeightGrams(source, menuByKey)
      : Math.max(0, Number(line.weight_grams || 0) || 0);
    out.push({
      ...line,
      qty,
      weight_grams: unit,
      name: source?.name || line.name,
    });
  }
  return out;
}

module.exports = {
  cartWeightKg,
  indexMenuRows,
  unitWeightGrams,
  resolveCartLineWeights,
  bundleComponentsOf,
};
