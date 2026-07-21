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

function parseBundleComponents(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const parts = text.split(/[,;|]/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const m = part.match(/^([A-Za-z0-9_-]+)\s*[:=xX×*]?\s*(\d+)?$/);
    if (!m) continue;
    const qty = Math.max(1, parseInt(m[2] || '1', 10) || 1);
    out.push({ retailer_id: m[1], qty });
  }
  return out.length ? out : null;
}

function parseMadeOnDate(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) {
    const dd = dmy[1].padStart(2, '0');
    const mm = dmy[2].padStart(2, '0');
    return `${dmy[3]}-${mm}-${dd}`;
  }
  const n = Number(s);
  if (Number.isFinite(n) && n > 20000 && n < 80000) {
    const epoch = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000;
    return new Date(epoch).toISOString().slice(0, 10);
  }
  return null;
}

function baseFields(row) {
  const id = strOrNull(row['id'] ?? row['ID'] ?? row['sku'] ?? row['SKU']);
  const name = strOrNull(row['title'] ?? row['name'] ?? row['Title'] ?? row['Name']);
  const price = parsePrice(row['price'] ?? row['Price']);
  const availRaw = row['is_available'] ?? row['Is Available'] ?? row['is_stocked'];

  return {
    id,
    name,
    description: strOrNull(row['description'] ?? row['Description']),
    price,
    category: strOrNull(row['category'] ?? row['Category']) ?? 'General',
    image_url: strOrNull(row['image_link'] ?? row['image_url'] ?? row['Image Link'] ?? row['Image URL']),
    is_available:
      availRaw === undefined || availRaw === null || availRaw === ''
        ? true
        : !['false', '0', 'no'].includes(String(availRaw).toLowerCase().trim()),
  };
}

function baseValidate(item, rowNum) {
  const errors = [];
  if (!item.id) errors.push(`Row ${rowNum}: missing id/SKU`);
  if (!item.name) errors.push(`Row ${rowNum}: missing title/name`);
  if (item.price <= 0) errors.push(`Row ${rowNum} (${item.name || item.id}): price must be > 0`);
  if (item.image_url && !/^https?:\/\//i.test(item.image_url)) {
    errors.push(`Row ${rowNum} (${item.name || item.id}): image_link must start with http:// or https://`);
  }
  return errors;
}

const BASE_PREVIEW_COLUMNS = [
  { key: 'id', label: 'SKU', mono: true, width: '8%' },
  { key: 'name', label: 'Name', bold: true, width: '22%' },
  { key: 'category', label: 'Category', width: '13%' },
  { key: 'price', label: 'Price', price: true, width: '8%' },
  { key: 'description', label: 'Description', width: '29%' },
  { key: 'image_url', label: 'Image', image: true, width: '20%' },
];

const BASE_TEMPLATE_HEADERS = ['id', 'title', 'description', 'price', 'category', 'image_link', 'is_available'];

const LOB_SCHEMAS = {
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
      ['M003', 'Assorted Sweets Box (500g)', 'Pre-packed sweets — packing counter', 350, 'Sweets', 'all', '', 'TRUE', 0, 1, 0, 'sweets_counter', 2, 'TRUE', 'main'],
    ],
    columnHelp: [
      ['Column guide - Restaurant / Cloud Kitchen / Tiffin'],
      [''],
      ['custom_label_0 - menu slot: Morning Tiffin, Lunch, Evening Snacks, Dinner (blank = all day)'],
      ['prep_time_fixed - fixed prep minutes before batch cooking (default 5)'],
      ['batch_size / time_per_batch - batch cook timing for scheduled orders'],
      ['kitchen_station - tawa, steamer, kadai, beverages, assembly, cold, sweets_counter (pre-packed → packing screen, skips live cooking KDS)'],
      ['packing_time - minutes per item for takeaway packing'],
      ['holds_well - TRUE if item can wait without quality loss'],
      ['fulfillment_section - counter id when multi-counter mode is on (default main)'],
    ],
    previewColumns: [
      { key: 'id', label: 'ID', mono: true, width: '8%' },
      { key: 'name', label: 'Name', bold: true, width: '22%' },
      { key: 'category', label: 'Category', width: '13%' },
      { key: 'time_slot', label: 'Slot', width: '12%' },
      { key: 'price', label: 'Price', price: true, width: '8%' },
      { key: 'description', label: 'Description', width: '17%' },
      { key: 'image_url', label: 'Image', image: true, width: '20%' },
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

  food_products: {
    id: 'food_products',
    label: 'Packaged Food / Home Baker',
    templateHeaders: [
      ...BASE_TEMPLATE_HEADERS,
      'item_type', 'variant_group_id', 'pack_size_label', 'weight_grams', 'current_stock',
      'availability_status', 'launch_at', 'deposit_amount',
      'shelf_life_days', 'made_on_date', 'ingredients', 'allergens',
      'bundle_components',
      'image_url_2', 'image_url_3', 'image_url_4', 'image_url_5',
      'discount_percent', 'discount_days',
    ],
    templateColWidths: [
      { wch: 10 }, { wch: 28 }, { wch: 40 }, { wch: 8 }, { wch: 14 }, { wch: 48 }, { wch: 12 },
      { wch: 10 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 14 }, { wch: 14 }, { wch: 12 },
      { wch: 12 }, { wch: 12 }, { wch: 28 }, { wch: 22 },
      { wch: 28 },
      { wch: 40 }, { wch: 40 }, { wch: 40 }, { wch: 40 },
      { wch: 14 }, { wch: 12 },
    ],
    templateExamples: [
      ['MP-250', 'Mango Pickle', 'Traditional Andhra-style mango pickle', 150, 'Pickles', '', 'TRUE', 'PRODUCT', 'MANGO-PICKLE', '250g', 250, 50, '', '', '', 90, '2026-07-15', 'Mango, chilli, mustard oil, salt', 'Mustard', '', '', '', '', '', 20, 7],
      ['MP-500', 'Mango Pickle', 'Traditional Andhra-style mango pickle', 280, 'Pickles', '', 'TRUE', 'PRODUCT', 'MANGO-PICKLE', '500g', 500, 40, '', '', '', 90, '2026-07-15', 'Mango, chilli, mustard oil, salt', 'Mustard', '', '', '', '', '', '', ''],
      ['MP-1KG', 'Mango Pickle', 'Traditional Andhra-style mango pickle', 520, 'Pickles', '', 'TRUE', 'PRODUCT', 'MANGO-PICKLE', '1kg', 1000, 20, '', '', '', 90, '2026-07-15', 'Mango, chilli, mustard oil, salt', 'Mustard', '', '', '', '', '', '', ''],
      ['MP-100', 'Mango Pickle', '100g jar for samplers', 70, 'Pickles', '', 'TRUE', 'PRODUCT', 'MANGO-PICKLE', '100g', 100, 100, '', '', '', 90, '2026-07-15', 'Mango, chilli, mustard oil, salt', 'Mustard', '', '', '', '', '', '', ''],
      ['NEW-GINGER', 'Ginger Pickle (launch)', 'Batch cooking next week', 180, 'Pickles', '', 'TRUE', 'PRODUCT', '', '250g', 250, '', 'coming_soon', '2026-08-01', 50, 90, '', 'Ginger, chilli, mustard oil', 'Mustard', '', '', '', '', '', '', ''],
      ['HAMPER-PICKLE-3', 'Pickle Sampler (3×100g)', 'Three favourite pickles in travel jars', 249, 'Hampers', '', 'TRUE', 'BUNDLE', '', '3×100g', 300, 15, '', '', '', 90, '2026-07-15', '', '', 'MP-100:3', '', '', '', '', '', ''],
    ],
    columnHelp: [
      ['Column guide - Packaged Food / Home Baker'],
      [''],
      ['item_type - PRODUCT (default) or BUNDLE (hamper / sampler)'],
      ['variant_group_id - same ID across pack rows for one product (e.g. MANGO-PICKLE)'],
      ['pack_size_label - 250g, 500g, 1kg (pack pills when variant_group_id is set)'],
      ['weight_grams - courier / Shiprocket parcel weight'],
      ['current_stock - batch jars on hand (blank = unlimited). 0 = sold out + waitlist'],
      ['availability_status - blank/in_stock | sold_out | coming_soon | preorder'],
      ['launch_at - ISO date for coming_soon (e.g. 2026-08-01)'],
      ['deposit_amount - optional preorder deposit (INR)'],
      ['shelf_life_days / made_on_date (YYYY-MM-DD) / ingredients / allergens - trust fields'],
      ['bundle_components - for BUNDLE only: retailer_id:qty, e.g. MP-100:3,GARLIC-100:3'],
      ['image_url_2 … image_url_5 - extra gallery photos for storefront / Instagram carousel'],
      ['discount_percent + discount_days - optional time-bound sale (e.g. 20 and 7 = 20% off for 7 days from upload)'],
      ['is_available - TRUE / FALSE'],
    ],
    previewColumns: [
      ...BASE_PREVIEW_COLUMNS.slice(0, 3),
      { key: 'pack_size_label', label: 'Pack', width: '8%' },
      { key: 'variant_group_id', label: 'Group', width: '10%' },
      { key: 'item_type', label: 'Type', width: '8%' },
      { key: 'availability_status', label: 'Status', width: '10%' },
      ...BASE_PREVIEW_COLUMNS.slice(3),
    ],
    mapRow(row) {
      const pack = strOrNull(row['pack_size_label'] ?? row['Pack Size']);
      const groupId = strOrNull(row['variant_group_id'] ?? row['Variant Group Id']);
      const itemType = String(row['item_type'] ?? row['Item Type'] ?? 'PRODUCT').trim().toUpperCase() || 'PRODUCT';
      const components = parseBundleComponents(row['bundle_components'] ?? row['Bundle Components']);
      const meta = {};
      if (components) meta.bundle_components = components;
      const availRaw = String(row['availability_status'] ?? row['Availability Status'] ?? '').toLowerCase().trim();
      const availability_status = ['coming_soon', 'preorder', 'sold_out', 'in_stock'].includes(availRaw)
        ? availRaw
        : null;
      const discountPctRaw = row['discount_percent'] ?? row['Discount Percent'] ?? row['Discount %'];
      const discountDaysRaw = row['discount_days'] ?? row['Discount Days'] ?? row['duration_days'];

      return {
        ...baseFields(row),
        time_slot: 'all',
        item_type: itemType === 'BUNDLE' || itemType === 'HAMPER' ? 'BUNDLE' : 'PRODUCT',
        variant_group_id: groupId,
        size_label: pack,
        pack_size_label: pack,
        weight_grams: row['weight_grams'] != null && row['weight_grams'] !== ''
          ? parseInt(String(row['weight_grams']).replace(/\D/g, ''), 10) || null
          : null,
        current_stock: row['current_stock'] != null && row['current_stock'] !== ''
          ? parseInt(String(row['current_stock']).replace(/\D/g, ''), 10)
          : null,
        availability_status,
        launch_at: strOrNull(row['launch_at'] ?? row['Launch At'] ?? row['launch_date']),
        deposit_amount: row['deposit_amount'] != null && row['deposit_amount'] !== ''
          ? parseFloat(String(row['deposit_amount']).replace(/[^\d.]/g, '')) || null
          : null,
        shelf_life_days: row['shelf_life_days'] != null && row['shelf_life_days'] !== ''
          ? parseInt(String(row['shelf_life_days']).replace(/\D/g, ''), 10) || null
          : null,
        made_on_date: parseMadeOnDate(row['made_on_date'] ?? row['Made On'] ?? row['made_on']),
        ingredients: strOrNull(row['ingredients'] ?? row['Ingredients']),
        allergens: strOrNull(row['allergens'] ?? row['Allergens']),
        bundle_components: components,
        meta: Object.keys(meta).length ? meta : undefined,
        image_url_2: strOrNull(row['image_url_2'] ?? row['Image URL 2']),
        image_url_3: strOrNull(row['image_url_3'] ?? row['Image URL 3']),
        image_url_4: strOrNull(row['image_url_4'] ?? row['Image URL 4']),
        image_url_5: strOrNull(row['image_url_5'] ?? row['Image URL 5']),
        discount_percent: discountPctRaw != null && discountPctRaw !== ''
          ? parseFloat(String(discountPctRaw).replace(/[^\d.]/g, '')) || null
          : null,
        discount_days: discountDaysRaw != null && discountDaysRaw !== ''
          ? parseInt(String(discountDaysRaw).replace(/\D/g, ''), 10) || null
          : null,
      };
    },
    validateRow(item, rowNum) {
      const errors = baseValidate(item, rowNum);
      if (item.variant_group_id && !item.pack_size_label && !item.size_label) {
        errors.push(`Row ${rowNum} (${item.name || item.id}): variant_group_id needs pack_size_label (e.g. 250g)`);
      }
      if (item.item_type === 'BUNDLE') {
        if (!item.bundle_components || !item.bundle_components.length) {
          errors.push(`Row ${rowNum} (${item.name || item.id}): BUNDLE rows need bundle_components (e.g. MP-100:3)`);
        }
      }
      if (item.discount_percent != null && (item.discount_percent < 1 || item.discount_percent > 100)) {
        errors.push(`Row ${rowNum} (${item.name || item.id}): discount_percent must be 1–100`);
      }
      if (item.discount_percent && (!item.discount_days || item.discount_days < 1)) {
        errors.push(`Row ${rowNum} (${item.name || item.id}): discount_percent needs discount_days (1–365)`);
      }
      return errors;
    },
  },

  retail: {
    id: 'retail',
    label: 'Retail / Electronics',
    templateHeaders: [
      ...BASE_TEMPLATE_HEADERS,
      'condition', 'original_mrp', 'warranty_days', 'colour',
      'image_url_2', 'image_url_3', 'image_url_4', 'image_url_5',
    ],
    templateColWidths: [
      { wch: 10 }, { wch: 26 }, { wch: 40 }, { wch: 8 }, { wch: 16 }, { wch: 48 }, { wch: 12 },
      { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 12 },
      { wch: 48 }, { wch: 48 }, { wch: 48 }, { wch: 48 },
    ],
    templateExamples: [
      ['RT001', 'iPhone 12 (Refurbished, 64GB)', 'Grade A refurbished', 24999, 'Phones', 'https://images.unsplash.com/photo-1592286927505-1def25115558?w=800', 'TRUE', 'Refurbished', 32999, 180, 'Black', '', '', '', ''],
    ],
    columnHelp: [
      ['Column guide - Retail / Electronics'],
      [''],
      ['category - customer-facing menu tab, e.g. Phones, Accessories'],
      ['condition - New / Refurbished / Used (shown in webcart product detail)'],
      ['original_mrp - optional; webcart shows a discount badge when higher than price'],
      ['image_link - primary image; image_url_2 … image_url_5 for extra gallery photos'],
    ],
    previewColumns: [
      ...BASE_PREVIEW_COLUMNS.slice(0, 3),
      { key: 'condition', label: 'Condition', width: '12%' },
      ...BASE_PREVIEW_COLUMNS.slice(3),
    ],
    mapRow(row) {
      const originalMrp = row['original_mrp'] != null && row['original_mrp'] !== ''
        ? parsePrice(row['original_mrp'])
        : null;
      return {
        ...baseFields(row),
        time_slot: 'all',
        condition: strOrNull(row['condition'] ?? row['Condition']),
        original_mrp: originalMrp && originalMrp > 0 ? originalMrp : null,
        warranty_days: row['warranty_days'] != null && row['warranty_days'] !== ''
          ? parseInt(String(row['warranty_days']).replace(/\D/g, ''), 10) || null
          : null,
        colour: strOrNull(row['colour'] ?? row['Colour'] ?? row['color'] ?? row['Color']),
        image_url_2: strOrNull(row['image_url_2'] ?? row['Image URL 2']),
        image_url_3: strOrNull(row['image_url_3'] ?? row['Image URL 3']),
        image_url_4: strOrNull(row['image_url_4'] ?? row['Image URL 4']),
        image_url_5: strOrNull(row['image_url_5'] ?? row['Image URL 5']),
      };
    },
    validateRow: baseValidate,
  },

  b2b: {
    id: 'b2b',
    label: 'B2B Supply',
    templateHeaders: BASE_TEMPLATE_HEADERS,
    templateColWidths: [{ wch: 10 }, { wch: 26 }, { wch: 40 }, { wch: 8 }, { wch: 16 }, { wch: 48 }, { wch: 12 }],
    templateExamples: [
      ['B001', 'Sunflower Oil (15L Tin)', 'Refined sunflower oil, bulk pack', 1850, 'Cooking Oils', '', 'TRUE'],
    ],
    columnHelp: [
      ['Column guide - B2B Supply'],
      [''],
      ['category - customer-facing menu tab, e.g. Cooking Oils, Grains'],
      ['Include unit size and MOQ in description, e.g. "15L tin, min 2 tins"'],
    ],
    previewColumns: BASE_PREVIEW_COLUMNS,
    mapRow(row) {
      return { ...baseFields(row), time_slot: 'all' };
    },
    validateRow: baseValidate,
  },

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

function getSchemaForLob(lobType) {
  return LOB_SCHEMAS[lobType] || LOB_SCHEMAS.restaurant;
}

/** LOB types valid at tenant registration and in Settings → Business type. */
const REGISTER_LOB_TYPES = Object.freeze(Object.keys(LOB_SCHEMAS));

function normalizeLobType(value, fallback = 'restaurant') {
  const raw = String(value ?? '').trim().toLowerCase();
  return REGISTER_LOB_TYPES.includes(raw) ? raw : fallback;
}

/**
 * Parse lob_type / org_type from registration payload.
 * Returns { lob_type, invalid, attempted? } — invalid=true when a non-empty unknown value was sent.
 */
function parseRegistrationLobType(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return { lob_type: 'restaurant', invalid: false };
  if (REGISTER_LOB_TYPES.includes(raw)) return { lob_type: raw, invalid: false };
  return { lob_type: null, invalid: true, attempted: raw };
}

module.exports = {
  LOB_SCHEMAS,
  getSchemaForLob,
  REGISTER_LOB_TYPES,
  normalizeLobType,
  parseRegistrationLobType,
};