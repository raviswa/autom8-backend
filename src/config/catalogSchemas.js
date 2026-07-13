// ============================================================================
// AUTOM8 — CATALOG LOB SCHEMAS
// src/config/catalogSchemas.js
//
// Single source of truth for catalog Excel upload behaviour per business
// type (tenants.lob_type), consumed by ManagerPortal.jsx.
//
// SCOPE (Step 2, first pass):
//   restaurant      — unchanged behaviour, existing tenants unaffected
//   food_products   — flat PRODUCT rows, no new DB columns
//   retail          — flat PRODUCT rows, no new DB columns
//   b2b             — flat PRODUCT rows, no new DB columns
//   psl             — PIZZA size variants, ice-cream flavours, crust/toppings,
//                      and add-ons (catalog schema + webcart rendering)
//   jewellery       — intentionally NOT included yet (live gold-rate pricing
//                      is a separate, unbuilt feature — see conversation).
//
// HOW THIS IS WIRED
// ─────────────────
// ManagerPortal already parses the uploaded Excel with
//   XLSX.utils.sheet_to_json(sheet, { defval: '' })
// which returns an array of OBJECTS keyed by the literal header text in
// row 1 (e.g. row.id, row.title, row.price). Each schema below operates on
// that same object shape — no header-row auto-detection or column-index
// lookup needed, since the header row is always row 1 by convention.
//
// The active schema is selected directly from the tenant's lob_type
// (fetched once via GET /api/dashboard/waba and stored in ManagerPortal
// state) — NOT auto-detected from file contents. Content-sniffing was
// considered but rejected: the owner's Settings → Business type choice is
// the single source of truth, matching "owner decides" from Step 5.
//
// TOPPINGS / CRUST / FLAVOURS / ADD-ONS
// ───────────────────────────────────────
// Flavours, scoops, crust, toppings, and add-ons are defined in the catalog
// upload schema (psl LOB) and rendered in webcart at order time.
// ============================================================================

// ─── Shared utilities ──────────────────────────────────────────────────────

function strOrNull(val) {
  const s = String(val ?? '').trim();
  return s || null;
}

function parsePrice(val) {
  if (val === null || val === undefined || val === '') return 0;
  return parseFloat(String(val).replace(/[^0-9.]/g, '')) || 0;
}

function parseBool(val, defaultVal = true) {
  if (val === null || val === undefined || val === '') return defaultVal;
  const s = String(val).toLowerCase().trim();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return defaultVal;
}

// Every schema's mapRow() returns this common shape at minimum. LOB-specific
// schemas may add extra keys (e.g. psl adds item_type/variant_group_id/
// size_label) — ManagerPortal passes the whole object through to
// POST /api/menu/upload, and the backend decides what it persists.
function baseFields(row) {
  const id     = strOrNull(row['id'] ?? row['ID'] ?? row['sku'] ?? row['SKU']);
  const name   = strOrNull(row['title'] ?? row['name'] ?? row['Title'] ?? row['Name']);
  const price  = parsePrice(row['price'] ?? row['Price']);
  const availRaw = row['is_available'] ?? row['Is Available'] ?? row['is_stocked'];
  return {
    id,
    name,
    description: strOrNull(row['description'] ?? row['Description']),
    price,
    category:    strOrNull(row['category'] ?? row['Category']) ?? 'General',
    image_url:   strOrNull(row['image_link'] ?? row['image_url'] ?? row['Image Link'] ?? row['Image URL']),
    is_available: availRaw === undefined || availRaw === null || availRaw === ''
      ? true
      : !['false', '0', 'no'].includes(String(availRaw).toLowerCase().trim()),
  };
}

function baseValidate(item, rowNum) {
  const errors = [];
  if (!item.id)        errors.push(`Row ${rowNum}: missing id/SKU`);
  if (!item.name)      errors.push(`Row ${rowNum}: missing title/name`);
  if (item.price <= 0) errors.push(`Row ${rowNum} (${item.name || item.id}): price must be > 0`);
  if (item.image_url && !/^https?:\/\//i.test(item.image_url)) {
    errors.push(`Row ${rowNum} (${item.name || item.id}): image_link must start with http:// or https://`);
  }
  return errors;
}

const BASE_PREVIEW_COLUMNS = [
  { key: 'id',          label: 'SKU',      mono: true,  width: '8%'  },
  { key: 'name',        label: 'Name',     bold: true,  width: '22%' },
  { key: 'category',    label: 'Category',              width: '13%' },
  { key: 'price',       label: 'Price',    price: true, width: '8%'  },
  { key: 'description', label: 'Description',           width: '29%' },
  { key: 'image_url',   label: 'Image',    image: true, width: '20%' },
];

const BASE_TEMPLATE_HEADERS = ['id', 'title', 'description', 'price', 'category', 'image_link', 'is_available'];

// ─── LOB_SCHEMAS ────────────────────────────────────────────────────────────

export const LOB_SCHEMAS = {

  // ══════════════════════════════════════════════════════════════════════
  // restaurant — unchanged from the original upload behaviour.
  // Keeps custom_label_0 (time slot) and kitchen-scheduling columns, since
  // existing tenants' templates already rely on these.
  // ══════════════════════════════════════════════════════════════════════
  restaurant: {
    id: 'restaurant',
    label: 'Restaurant / Cloud Kitchen / Tiffin',

    templateHeaders: [
      'id', 'title', 'description', 'price', 'category', 'custom_label_0', 'image_link', 'is_available',
      'prep_time_fixed', 'batch_size', 'time_per_batch', 'kitchen_station', 'packing_time', 'holds_well', 'fulfillment_section',
    ],
    templateColWidths: [
      { wch: 8 }, { wch: 28 }, { wch: 40 }, { wch: 8 }, { wch: 16 }, { wch: 16 }, { wch: 48 }, { wch: 12 },
      { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 16 },
    ],
    templateExamples: [
      ['M001', 'Idli (2 pcs)', 'Soft steamed idlis with sambar and chutney', 30, 'Tiffin', 'Morning Tiffin', 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800', 'TRUE', 5, 1, 10, 'steamer', 1, 'FALSE', 'main'],
      ['M002', 'Ghee Rice + Kurma', 'Fragrant ghee rice with vegetable kurma', 90, 'Rice & Meals', 'Lunch', 'https://images.unsplash.com/photo-1596797038530-2c107229654b?w=800', 'TRUE', 15, 1, 15, 'kadai', 2, 'TRUE', 'main'],
    ],
    columnHelp: [
      ['Column guide — Restaurant / Cloud Kitchen / Tiffin'],
      [''],
      ['custom_label_0 — menu slot: Morning Tiffin, Lunch, Evening Snacks, Dinner (blank = all day)'],
      ['prep_time_fixed — fixed prep minutes before batch cooking (default 5)'],
      ['batch_size / time_per_batch — batch cook timing for scheduled orders'],
      ['kitchen_station — tawa, steamer, kadai, beverages, assembly, cold'],
      ['packing_time — minutes per item for takeaway packing'],
      ['holds_well — TRUE if item can wait without quality loss'],
      ['fulfillment_section — counter id when multi-counter mode is on (default main)'],
    ],

    previewColumns: [
      { key: 'id',          label: 'ID',       mono: true,  width: '8%'  },
      { key: 'name',        label: 'Name',     bold: true,  width: '22%' },
      { key: 'category',    label: 'Category',              width: '13%' },
      { key: 'time_slot',   label: 'Slot',                  width: '12%' },
      { key: 'price',       label: 'Price',    price: true, width: '8%'  },
      { key: 'description', label: 'Description',           width: '17%' },
      { key: 'image_url',   label: 'Image',    image: true, width: '20%' },
    ],

    mapRow(row) {
      const base = baseFields(row);
      const customSlot = strOrNull(row['custom_label_0'] ?? row['Custom Label 0']);
      return {
        ...base,
        time_slot: customSlot ? customSlot.toLowerCase().replace(/\s+/g, '_') : 'all',
        custom_label_0: customSlot,
        prep_time_fixed: row['prep_time_fixed'],
        batch_size: row['batch_size'],
        time_per_batch: row['time_per_batch'],
        kitchen_station: row['kitchen_station'],
        packing_time: row['packing_time'],
        holds_well: row['holds_well'],
        fulfillment_section: row['fulfillment_section'],
      };
    },

    validateRow(item, rowNum) {
      const errors = baseValidate(item, rowNum);
      if (!item.category || item.category === 'General') {
        errors.push(`Row ${rowNum} (${item.name || item.id}): missing category (e.g. Tiffin, Beverages, Snacks)`);
      }
      return errors;
    },
  },

  // ══════════════════════════════════════════════════════════════════════
  // food_products — flat PRODUCT rows. No new DB columns; extra
  // pack-size/shelf-life/ingredients fields are NOT persisted in this pass
  // (no live tenant on this LOB yet — add if/when one exists).
  // ══════════════════════════════════════════════════════════════════════
  food_products: {
    id: 'food_products',
    label: 'Packaged Food / Home Baker',
    templateHeaders: BASE_TEMPLATE_HEADERS,
    templateColWidths: [
      { wch: 10 }, { wch: 26 }, { wch: 40 }, { wch: 8 }, { wch: 16 }, { wch: 48 }, { wch: 12 },
    ],
    templateExamples: [
      ['FP001', 'Homemade Chocolate Brownie (6 pcs)', 'Rich fudgy brownies, baked fresh', 249, 'Bakes', 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=800', 'TRUE'],
      ['FP002', 'Mango Pickle (250g)', 'Traditional Andhra-style mango pickle', 150, 'Pickles', '', 'TRUE'],
    ],
    columnHelp: [
      ['Column guide — Packaged Food / Home Baker'],
      [''],
      ['category — used as the customer-facing menu tab, e.g. Bakes, Pickles, Snacks'],
      ['image_link — direct image URL; leave blank if you have no photo yet'],
      ['is_available — TRUE / FALSE. FALSE = greyed out, toggle anytime from Manager Portal'],
    ],
    previewColumns: BASE_PREVIEW_COLUMNS,
    mapRow(row) {
      return { ...baseFields(row), time_slot: 'all' };
    },
    validateRow: baseValidate,
  },

  // ══════════════════════════════════════════════════════════════════════
  // retail — flat PRODUCT rows. Same reasoning as food_products.
  // ══════════════════════════════════════════════════════════════════════
  retail: {
    id: 'retail',
    label: 'Retail / Electronics',
    templateHeaders: BASE_TEMPLATE_HEADERS,
    templateColWidths: [
      { wch: 10 }, { wch: 26 }, { wch: 40 }, { wch: 8 }, { wch: 16 }, { wch: 48 }, { wch: 12 },
    ],
    templateExamples: [
      ['RT001', 'iPhone 12 (Refurbished, 64GB)', 'Grade A refurbished, 6-month warranty', 24999, 'Phones', 'https://images.unsplash.com/photo-1592286927505-1def25115558?w=800', 'TRUE'],
    ],
    columnHelp: [
      ['Column guide — Retail / Electronics'],
      [''],
      ['category — used as the customer-facing menu tab, e.g. Phones, Accessories'],
      ['Include condition, warranty, and specs in the description for now'],
    ],
    previewColumns: BASE_PREVIEW_COLUMNS,
    mapRow(row) {
      return { ...baseFields(row), time_slot: 'all' };
    },
    validateRow: baseValidate,
  },

  // ══════════════════════════════════════════════════════════════════════
  // b2b — flat PRODUCT rows. Same reasoning as food_products.
  // ══════════════════════════════════════════════════════════════════════
  b2b: {
    id: 'b2b',
    label: 'B2B Supply',
    templateHeaders: BASE_TEMPLATE_HEADERS,
    templateColWidths: [
      { wch: 10 }, { wch: 26 }, { wch: 40 }, { wch: 8 }, { wch: 16 }, { wch: 48 }, { wch: 12 },
    ],
    templateExamples: [
      ['B001', 'Sunflower Oil (15L Tin)', 'Refined sunflower oil, bulk pack', 1850, 'Cooking Oils', '', 'TRUE'],
    ],
    columnHelp: [
      ['Column guide — B2B Supply'],
      [''],
      ['category — used as the customer-facing menu tab, e.g. Cooking Oils, Grains'],
      ['Include unit size and MOQ in the description for now, e.g. "15L tin, min 2 tins"'],
    ],
    previewColumns: BASE_PREVIEW_COLUMNS,
    mapRow(row) {
      return { ...baseFields(row), time_slot: 'all' };
    },
    validateRow: baseValidate,
  },

  // ══════════════════════════════════════════════════════════════════════
  // psl — Pizza & Ice Cream (mixed outlet). Supports size-linked pizzas,
  // ice-cream flavour groups, crust/topping customization, and add-ons.
  // Flavours, scoops, crust, toppings, and add-ons are defined in the
  // catalog upload schema and rendered in webcart at order time.
  // ══════════════════════════════════════════════════════════════════════
  psl: {
    id: 'psl',
    label: 'Pizza & Ice Cream (mixed outlet)',
    templateHeaders: [
      'id', 'item_type', 'variant_group_id', 'size_label', 'flavour_group', 'scoop_count',
      'crust_options', 'toppings_allowed', 'topping_extra_price',
      'title', 'description', 'price', 'category', 'image_link', 'is_available',
    ],
    templateColWidths: [
      { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 10 },
      { wch: 16 }, { wch: 14 }, { wch: 14 },
      { wch: 26 }, { wch: 40 }, { wch: 8 }, { wch: 16 }, { wch: 48 }, { wch: 12 },
    ],
    templateExamples: [
      ['IC-CUP', 'CUP', '', '', 'GRP-A', 2, '', '', '', 'Double Scoop Cup', 'Pick 2 flavours', 120, 'Ice Cream', '', 'TRUE'],
      ['IC-FV1', 'FLAVOUR', '', '', 'GRP-A', '', '', '', '', 'Vanilla', '', 0, 'Flavours', '', 'TRUE'],
      ['IC-FV2', 'FLAVOUR', '', '', 'GRP-A,GRP-B', '', '', '', '', 'Chocolate', '', 0, 'Flavours', '', 'TRUE'],
      ['PZ001-S', 'PIZZA', 'PZ001', 'Small', '', 1, 'Thin,Thick,Stuffed', 'TRUE', 49, 'Margherita', 'Classic tomato base, mozzarella, basil', 199, 'Pizza', 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800', 'TRUE'],
      ['PZ001-M', 'PIZZA', 'PZ001', 'Medium', '', 1, 'Thin,Thick,Stuffed', 'TRUE', 49, 'Margherita', 'Classic tomato base, mozzarella, basil', 299, 'Pizza', 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800', 'TRUE'],
      ['PZ001-L', 'PIZZA', 'PZ001', 'Large', '', 1, 'Thin,Thick,Stuffed', 'TRUE', 49, 'Margherita', 'Classic tomato base, mozzarella, basil', 449, 'Pizza', 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800', 'TRUE'],
      ['EX001', 'ADDON', '', '', '', '', '', '', '', 'Garlic Bread', 'Side', 99, 'Sides', '', 'TRUE'],
      ['FR001', 'PRODUCT', '', '', '', '', '', '', '', 'French Fries', 'Crispy golden fries with seasoning', 79, 'Snacks', '', 'TRUE'],
    ],
    columnHelp: [
      ['Column guide - Pizza & Ice Cream'],
      [''],
      ['item_type - PIZZA | CUP | CONE | SUNDAE | FLAVOUR | ADDON | PRODUCT (fallback for blank/unrecognized)'],
      ['variant_group_id - same ID across size rows for one pizza (e.g. PZ001)'],
      ['size_label - Small / Medium / Large. Required for PIZZA rows with variant_group_id'],
      ['flavour_group - groups CUP/CONE/SUNDAE with FLAVOUR options; comma-separated for multi-group flavours'],
      ['scoop_count - max flavours selectable (default 1 if blank)'],
      ['crust_options - comma-separated crust choices, PIZZA only (e.g. Thin,Thick,Stuffed)'],
      ['toppings_allowed - TRUE/FALSE for PIZZA crust/topping customizer'],
      ['topping_extra_price - price per topping when toppings_allowed = TRUE'],
      ['Flavours, scoops, crust, toppings, and add-ons are defined in the catalog upload schema and rendered in webcart at order time.'],
    ],
    previewColumns: [
      { key: 'id', label: 'SKU', mono: true, width: '8%' },
      { key: 'item_type', label: 'Type', pill: true, width: '8%' },
      { key: 'variant_group_id', label: 'Group', width: '8%' },
      { key: 'size_label', label: 'Size', width: '7%' },
      { key: 'flavour_group', label: 'Flavour Grp', width: '9%' },
      { key: 'scoop_count', label: 'Scoops', width: '6%' },
      { key: 'name', label: 'Name', bold: true, width: '15%' },
      { key: 'category', label: 'Category', width: '11%' },
      { key: 'price', label: 'Price', price: true, width: '8%' },
      { key: 'image_url', label: 'Image', image: true, width: '20%' },
    ],
    mapRow(row) {
      const base = baseFields(row);
      const rawType = String(row['item_type'] ?? row['Item Type'] ?? '').trim().toUpperCase();
      const itemType = rawType || 'PRODUCT';
      return {
        ...base,
        time_slot: 'all',
        item_type: itemType,
        variant_group_id: strOrNull(row['variant_group_id'] ?? row['Variant Group Id']),
        size_label: strOrNull(row['size_label'] ?? row['Size Label'] ?? row['size']),
        flavour_group: strOrNull(row['flavour_group'] ?? row['Flavour Group']),
        scoop_count: Math.max(1, parseInt(row['scoop_count'], 10) || 1),
        crust_options: strOrNull(row['crust_options'] ?? row['Crust Options']),
        toppings_allowed: parseBool(row['toppings_allowed'], false),
        topping_extra_price: parsePrice(row['topping_extra_price']),
      };
    },
    validateRow(item, rowNum) {
      const errors = [];
      if (!item.id) errors.push(`Row ${rowNum}: missing id/SKU`);
      if (!item.name) errors.push(`Row ${rowNum}: missing title/name`);
      if (item.item_type !== 'FLAVOUR' && item.price <= 0) {
        errors.push(`Row ${rowNum} (${item.name || item.id}): price must be > 0`);
      }
      if (item.image_url && !/^https?:\/\//i.test(item.image_url)) {
        errors.push(`Row ${rowNum} (${item.name || item.id}): image_link must start with http:// or https://`);
      }
      if (item.item_type === 'PIZZA' && !item.variant_group_id) {
        errors.push(`Row ${rowNum} (${item.name || item.id}): PIZZA rows need a variant_group_id`);
      }
      if (item.variant_group_id && !item.size_label) {
        errors.push(`Row ${rowNum} (${item.name || item.id}): has variant_group_id but no size_label`);
      }
      if (item.item_type === 'PIZZA' && item.toppings_allowed && item.topping_extra_price <= 0) {
        errors.push(`Row ${rowNum} (${item.name || item.id}): toppings_allowed requires topping_extra_price > 0`);
      }
      if (['CUP', 'CONE', 'SUNDAE'].includes(item.item_type) && !item.flavour_group) {
        errors.push(`Row ${rowNum} (${item.name || item.id}): ${item.item_type} rows need a flavour_group`);
      }
      if (item.item_type === 'FLAVOUR') {
        const groups = (item.flavour_group || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!groups.length) {
          errors.push(`Row ${rowNum} (${item.name || item.id}): FLAVOUR rows need at least one flavour_group value`);
        }
      }
      return errors;
    },
  },
};

// ─── Resolver ───────────────────────────────────────────────────────────────

/**
 * Resolves the active schema for a tenant. Source of truth is
 * tenants.lob_type (owner-set in Settings → Business type) — NOT content
 * sniffing. Falls back to 'restaurant' for any unrecognised/legacy value,
 * which matches current behaviour for every existing tenant.
 */
export function getSchemaForLob(lobType) {
  return LOB_SCHEMAS[lobType] || LOB_SCHEMAS.restaurant;
}

/** LOB types valid at tenant registration and in Settings → Business type. */
export const REGISTER_LOB_TYPES = Object.freeze(Object.keys(LOB_SCHEMAS));

export function normalizeLobType(value, fallback = 'restaurant') {
  const raw = String(value ?? '').trim().toLowerCase();
  return REGISTER_LOB_TYPES.includes(raw) ? raw : fallback;
}

/**
 * Parse lob_type / org_type from registration payload.
 * Returns { lob_type, invalid, attempted? } — invalid=true when a non-empty unknown value was sent.
 */
export function parseRegistrationLobType(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return { lob_type: 'restaurant', invalid: false };
  if (REGISTER_LOB_TYPES.includes(raw)) return { lob_type: raw, invalid: false };
  return { lob_type: null, invalid: true, attempted: raw };
}
