'use strict';

/**
 * Brochure page-1 taxonomy: three families, each with verticals (+ Others).
 * Catalog / portal behavior keys off lob_type (schema); vertical is the label.
 * Family id `restaurant` is kept for DB/engine compatibility; display label is Food & Beverages.
 */

const LOB_FAMILIES = Object.freeze([
  {
    id: 'restaurant',
    label: 'Food & Beverages',
    badge: 'Beyond Food & Beverages',
    icon: '🍽️',
    tagline: 'Ordering, kitchen, tables and customer relationships on WhatsApp.',
  },
  {
    id: 'retail',
    label: 'Retail & Makers',
    badge: 'Beyond Retail',
    icon: '🛍️',
    tagline: 'Turn your WhatsApp catalog into a real storefront.',
  },
  {
    id: 'b2b',
    label: 'B2B / Wholesale',
    badge: 'Beyond B2B',
    icon: '📦',
    tagline: 'Bulk ordering, credit tracking and reorders on WhatsApp.',
  },
  {
    id: 'other',
    label: 'Others',
    badge: 'Something else',
    icon: '✳️',
    tagline: 'Not on the list? Tell us what you sell and we will set you up.',
    custom: true,
  },
]);

const LOB_VERTICALS = Object.freeze([
  // Food & Beverages family (engine id: restaurant)
  { id: 'cloud_kitchen', family: 'restaurant', label: 'Cloud Kitchens', icon: '🍳', lob_type: 'restaurant' },
  { id: 'bakery_sweets', family: 'restaurant', label: 'Bakery & Sweet Shops', icon: '🍰', lob_type: 'restaurant' },
  { id: 'meat_chicken_fish', family: 'restaurant', label: 'Meat, Chicken & Fish Shops', icon: '🥩', lob_type: 'restaurant' },
  { id: 'pizza_ice_cream', family: 'restaurant', label: 'Pizza & Ice Cream Parlours', icon: '🍕', lob_type: 'psl' },
  { id: 'casual_cafe', family: 'restaurant', label: 'Casual Cafe', icon: '☕', lob_type: 'restaurant' },
  { id: 'tiffin_home_chefs', family: 'restaurant', label: 'Tiffin & Home Chefs', icon: '🍱', lob_type: 'restaurant' },
  { id: 'food_products', family: 'restaurant', label: 'Food Products', icon: '🥫', lob_type: 'food_products' },
  { id: 'other_food_beverages', family: 'restaurant', label: 'Others', icon: '✏️', lob_type: 'restaurant', custom: true },

  // Retail family
  { id: 'home_decor', family: 'retail', label: 'Home Décor & Interiors', icon: '🕯️', lob_type: 'retail' },
  { id: 'handmade_crafts', family: 'retail', label: 'Handmade Crafts & Dolls', icon: '🧸', lob_type: 'retail' },
  { id: 'fashion_jewellery', family: 'retail', label: 'Artificial/Fashion Jewellery', icon: '💍', lob_type: 'retail' },
  { id: 'organic_products', family: 'retail', label: 'Organic Products', icon: '🌿', lob_type: 'retail' },
  { id: 'florists_plants', family: 'retail', label: 'Florists, Plants & Gardening', icon: '🪴', lob_type: 'retail' },
  { id: 'electronics_accessories', family: 'retail', label: 'Electronics/Accessories', icon: '🔌', lob_type: 'retail' },
  { id: 'other_retail', family: 'retail', label: 'Others', icon: '✏️', lob_type: 'retail', custom: true },

  // B2B family
  { id: 'fb_distributors', family: 'b2b', label: 'F&B distributors (dairy/veg/meat)', icon: '🚛', lob_type: 'b2b' },
  { id: 'packaging_suppliers', family: 'b2b', label: 'Packaging suppliers', icon: '📦', lob_type: 'b2b' },
  { id: 'kirana_fmcg', family: 'b2b', label: 'Kirana/FMCG distributors', icon: '🏬', lob_type: 'b2b' },
  { id: 'raw_material_suppliers', family: 'b2b', label: 'Raw-material suppliers', icon: '🏭', lob_type: 'b2b' },
  { id: 'general_trade_wholesale', family: 'b2b', label: 'General trade wholesale', icon: '🧾', lob_type: 'b2b' },
  { id: 'other_b2b', family: 'b2b', label: 'Others', icon: '✏️', lob_type: 'b2b', custom: true },

  // Others family — merchant describes the business in their own words.
  { id: 'other_business', family: 'other', label: 'Others', icon: '✳️', lob_type: 'retail', custom: true },
]);

const FAMILY_BY_ID = Object.freeze(
  Object.fromEntries(LOB_FAMILIES.map((family) => [family.id, family])),
);

const VERTICAL_BY_ID = Object.freeze(
  Object.fromEntries(LOB_VERTICALS.map((vertical) => [vertical.id, vertical])),
);

/** Schema lob_type → owning family, for tenants registered before the taxonomy existed. */
const FAMILY_BY_LOB_TYPE = Object.freeze({
  restaurant: 'restaurant',
  psl: 'restaurant',
  food_products: 'restaurant',
  retail: 'retail',
  jewellery: 'retail',
  electronics: 'retail',
  b2b: 'b2b',
  supply: 'b2b',
});

/** Vertical ids that resolve to a catalog schema — used as LOB aliases. */
const VERTICAL_LOB_ALIASES = Object.freeze(
  Object.fromEntries(LOB_VERTICALS.map((vertical) => [vertical.id, vertical.lob_type])),
);

function getFamily(familyId) {
  return FAMILY_BY_ID[String(familyId || '').trim().toLowerCase()] || null;
}

function getVertical(verticalId) {
  return VERTICAL_BY_ID[String(verticalId || '').trim().toLowerCase()] || null;
}

function verticalsForFamily(familyId) {
  const id = String(familyId || '').trim().toLowerCase();
  return LOB_VERTICALS.filter((vertical) => vertical.family === id);
}

function otherFamilies(familyId) {
  const id = String(familyId || '').trim().toLowerCase();
  return LOB_FAMILIES.filter((family) => family.id !== id && !family.custom);
}

function isCustomVertical(verticalId) {
  return !!getVertical(verticalId)?.custom;
}

/** The single custom ("Others") vertical belonging to a family, if any. */
function customVerticalForFamily(familyId) {
  return verticalsForFamily(familyId).find((vertical) => vertical.custom) || null;
}

function resolveLobTypeFromVertical(verticalId, fallback = 'restaurant') {
  const vertical = getVertical(verticalId);
  return vertical?.lob_type || fallback;
}

/**
 * Resolve registration / settings selection into family, vertical, and schema lob_type.
 * Prefers explicit vertical; falls back to family default or raw lob_type.
 */
function resolveBusinessTaxonomy({
  business_family = null,
  business_vertical = null,
  business_vertical_other = null,
  lob_type = null,
} = {}) {
  const otherLabel = String(business_vertical_other || '').trim() || null;
  const vertical = getVertical(business_vertical);
  if (vertical) {
    return {
      business_family: vertical.family,
      business_vertical: vertical.id,
      business_vertical_other: vertical.custom ? otherLabel : null,
      lob_type: vertical.lob_type,
      family: getFamily(vertical.family),
      vertical,
    };
  }

  const family = getFamily(business_family);
  if (family) {
    const defaultVertical = verticalsForFamily(family.id).find((item) => !item.custom)
      || customVerticalForFamily(family.id);
    return {
      business_family: family.id,
      business_vertical: defaultVertical?.id || null,
      business_vertical_other: defaultVertical?.custom ? otherLabel : null,
      lob_type: defaultVertical?.lob_type || (family.id === 'b2b' ? 'b2b' : family.id === 'restaurant' ? 'restaurant' : 'retail'),
      family,
      vertical: defaultVertical,
    };
  }

  const rawLob = String(lob_type || '').trim().toLowerCase();
  const inferredVertical = LOB_VERTICALS.find((item) => !item.custom && item.id === rawLob) || null;
  if (inferredVertical) {
    return {
      business_family: inferredVertical.family,
      business_vertical: inferredVertical.id,
      business_vertical_other: null,
      lob_type: inferredVertical.lob_type,
      family: getFamily(inferredVertical.family),
      vertical: inferredVertical,
    };
  }

  // A bare schema lob_type (legacy tenants) identifies the family but not which
  // vertical inside it — never guess, or a plain restaurant reads "Cloud Kitchens".
  const inferredFamily = getFamily(FAMILY_BY_LOB_TYPE[rawLob]);
  if (inferredFamily) {
    return {
      business_family: inferredFamily.id,
      business_vertical: null,
      business_vertical_other: null,
      lob_type: rawLob,
      family: inferredFamily,
      vertical: null,
    };
  }

  return {
    business_family: null,
    business_vertical: null,
    business_vertical_other: null,
    lob_type: rawLob || 'restaurant',
    family: null,
    vertical: null,
  };
}

function formatBusinessLabel({
  business_family,
  business_vertical,
  business_vertical_other,
  lob_type,
} = {}) {
  const resolved = resolveBusinessTaxonomy({
    business_family,
    business_vertical,
    business_vertical_other,
    lob_type,
  });
  const otherLabel = String(business_vertical_other || resolved.business_vertical_other || '').trim();
  if (resolved.family && resolved.vertical?.custom && otherLabel) {
    return `${resolved.family.label} · ${otherLabel}`;
  }
  if (resolved.family && resolved.vertical?.custom) {
    return `${resolved.family.label} · Others`;
  }
  if (resolved.family && resolved.vertical) {
    return `${resolved.family.label} · ${resolved.vertical.label}`;
  }
  if (resolved.family) return resolved.family.label;
  if (resolved.vertical) return resolved.vertical.label;
  return resolved.lob_type || 'Business';
}

module.exports = {
  LOB_FAMILIES,
  LOB_VERTICALS,
  VERTICAL_LOB_ALIASES,
  getFamily,
  getVertical,
  verticalsForFamily,
  otherFamilies,
  isCustomVertical,
  customVerticalForFamily,
  resolveLobTypeFromVertical,
  resolveBusinessTaxonomy,
  formatBusinessLabel,
};
