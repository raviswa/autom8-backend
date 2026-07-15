// ============================================================================
// Munafe Supply — per-supplier LOB catalog schemas
// src/config/supplyCatalogSchemas.js
//
// Categories / units / GST defaults for supply_catalog_items, keyed by
// suppliers.lob_type. Independent of tenants.lob_type + menu catalogSchemas.
// ============================================================================

'use strict';

const VALID_UNIT_TYPES = ['count', 'weight', 'volume'];

const FOOD_SERVICE_UNITS = [
  'kg', 'g', 'litre', 'ml', 'dozen', 'piece', 'bunch', 'bag', 'crate', 'sack',
];

const SUPPLY_LOB_SCHEMAS = {
  food_service: {
    lob_type: 'food_service',
    label: 'Food service (F&B ingredients)',
    categories: [
      'Vegetables',
      'Fruits',
      'Dairy',
      'Eggs & Poultry',
      'Meat & Seafood',
      'Dry Goods',
      'Oils & Fats',
      'Spices',
      'Packaging',
      'Other',
    ],
    gstDefaults: {
      'Vegetables': 0,
      'Fruits': 0,
      'Dairy': 0,
      'Eggs & Poultry': 0,
      'Meat & Seafood': 0,
      'Dry Goods': 0,
      'Oils & Fats': 5,
      'Spices': 5,
      'Packaging': 18,
      'Other': 5,
    },
    units: FOOD_SERVICE_UNITS,
  },

  food_products: {
    lob_type: 'food_products',
    label: 'Packaged food products',
    categories: [
      'Packaged Food',
      'Beverages',
      'Snacks',
      'Frozen',
      'Condiments',
      'Other',
    ],
    gstDefaults: {
      'Packaged Food': 5,
      'Beverages': 12,
      'Snacks': 12,
      'Frozen': 5,
      'Condiments': 12,
      'Other': 5,
    },
    units: [
      'piece', 'pack', 'carton', 'kg', 'g', 'litre', 'ml', 'dozen', 'bag', 'crate',
    ],
  },

  retail: {
    lob_type: 'retail',
    label: 'Retail / general merchandise',
    categories: [
      'Grocery',
      'Household',
      'Personal Care',
      'Electronics Acc.',
      'Stationery',
      'Other',
    ],
    gstDefaults: {
      'Grocery': 5,
      'Household': 18,
      'Personal Care': 18,
      'Electronics Acc.': 18,
      'Stationery': 12,
      'Other': 18,
    },
    units: [
      'piece', 'pack', 'box', 'carton', 'kg', 'litre', 'set',
    ],
  },

  packaging: {
    lob_type: 'packaging',
    label: 'Packaging & disposables',
    categories: [
      'Food Packaging',
      'Shipping',
      'Disposable',
      'Labels & Print',
      'Other',
    ],
    gstDefaults: {
      'Food Packaging': 18,
      'Shipping': 18,
      'Disposable': 18,
      'Labels & Print': 18,
      'Other': 18,
    },
    units: [
      'piece', 'pack', 'roll', 'bag', 'kg', 'carton',
    ],
  },

  general: {
    lob_type: 'general',
    label: 'General wholesale',
    categories: ['General', 'Other'],
    gstDefaults: {
      'General': 18,
      'Other': 18,
    },
    units: [
      'piece', 'pack', 'kg', 'g', 'litre', 'ml', 'dozen', 'bag', 'box',
      'carton', 'crate', 'sack', 'bunch',
    ],
  },
};

const DEFAULT_LOB = 'food_service';

function getSupplySchema(lobType) {
  const key = String(lobType || DEFAULT_LOB).trim().toLowerCase();
  return SUPPLY_LOB_SCHEMAS[key] || SUPPLY_LOB_SCHEMAS[DEFAULT_LOB];
}

function listSupplyLobTypes() {
  return Object.keys(SUPPLY_LOB_SCHEMAS);
}

function defaultUnitType(unit) {
  const u = String(unit || '').toLowerCase();
  if (['piece', 'dozen', 'bunch', 'pack', 'box', 'carton', 'set', 'roll'].includes(u)) {
    return 'count';
  }
  if (['litre', 'ml'].includes(u)) return 'volume';
  return 'weight';
}

function resolveGst(schema, category, gstRate) {
  if (gstRate != null && gstRate !== '' && !Number.isNaN(Number(gstRate))) {
    return Number(gstRate);
  }
  return schema.gstDefaults[category] ?? 0;
}

/**
 * Full-create validation (POST / bulk-upload row).
 * Returns an array of error strings (empty = valid).
 */
function validateItem(schema, body) {
  const errors = [];
  if (!body?.name?.trim()) errors.push('name is required');
  if (!schema.categories.includes(body?.category)) {
    errors.push(`category must be one of: ${schema.categories.join(', ')}`);
  }
  if (!schema.units.includes(body?.unit)) {
    errors.push(`unit must be one of: ${schema.units.join(', ')}`);
  }
  if (body?.unit_type != null && !VALID_UNIT_TYPES.includes(body.unit_type)) {
    errors.push(`unit_type must be one of: ${VALID_UNIT_TYPES.join(', ')}`);
  }
  if (
    body?.default_price == null
    || Number.isNaN(Number(body.default_price))
    || Number(body.default_price) < 0
  ) {
    errors.push('default_price must be a non-negative number');
  }
  return errors;
}

function schemaMeta(schema) {
  return {
    lob_type: schema.lob_type,
    label: schema.label,
    categories: schema.categories,
    units: schema.units,
    gst_defaults: { ...schema.gstDefaults },
    unit_types: [...VALID_UNIT_TYPES],
  };
}

module.exports = {
  SUPPLY_LOB_SCHEMAS,
  DEFAULT_LOB,
  VALID_UNIT_TYPES,
  getSupplySchema,
  listSupplyLobTypes,
  defaultUnitType,
  resolveGst,
  validateItem,
  schemaMeta,
};
