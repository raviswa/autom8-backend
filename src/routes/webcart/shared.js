'use strict';

const path = require('path');
const { supabaseAdmin } = require('../../config/supabase');
const { getKdsSecret } = require('../../config/internalSecret');
const {
  normalizePincode,
  resolveCourierZone,
  chargeFromRateCard,
  normalizeShippingProvider,
} = require('../../helpers/courierRates');
const { fetchShiprocketCheapestRate } = require('../../helpers/shiprocket');
const { getAffinityForWebcart } = require('../../helpers/productAffinity');
const {
  cartWeightKg,
  resolveCartLineWeights,
} = require('../../helpers/cartWeight');
const {
  deductStockForLines,
  joinStockWaitlist,
} = require('../../helpers/inventory');
const { deriveMenuDiscount } = require('../../helpers/menuDiscount');

const ACTIVE_TOKEN_STATUSES = new Set(['waiting', 'pending_approval', 'seated', 'takeaway', 'delivery']);
const DEFAULT_THEME = {
  primary_color: '#C2410C',
  accent_color: '#111827',
};
const CHAT_SERVICE_URL = (process.env.CHAT_SERVICE_URL || 'http://localhost:8001').replace(/\/$/, '');
const SHIPPED_LOBS = new Set(['food_products', 'retail', 'psl', 'b2b']);

// Webcart APIs are polled frequently by the frontend. Keep tiny in-memory caches
// to avoid repeated identical DB reads during launch/refresh loops.
const RESTAURANT_CACHE_TTL_MS = 60 * 1000;
const MENU_CACHE_TTL_MS = 45 * 1000;
let _restaurantCache = { rows: null, fetchedAt: 0 };
const _menuCache = new Map(); // restaurantId -> { items, categorySlotMap, fetchedAt }

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

/** PostgREST "column missing from schema cache" (migration not applied yet). */
function isMissingColumnError(err) {
  const hay = `${err?.code || ''} ${err?.message || ''} ${err?.details || ''} ${err?.hint || ''}`.toLowerCase();
  return (
    hay.includes('pgrst204')
    || (hay.includes('could not find') && hay.includes('column'))
    || /column .+ does not exist/.test(hay)
  );
}

function columnFromSchemaError(err) {
  const msg = String(err?.message || '');
  const m =
    msg.match(/Could not find the '([a-z0-9_]+)' column/i)
    || msg.match(/column\s+(?:\w+\.)?([a-z0-9_]+)\s+does not exist/i)
    || msg.match(/'([a-z0-9_]+)' column of/i);
  return m ? m[1] : null;
}

/**
 * Run a Supabase select, dropping any columns the live DB doesn't have yet.
 * Prevents a single unapplied migration from 500-ing the whole webcart session.
 */
async function selectDroppingMissingColumns(label, columnsCsv, runSelect) {
  let columns = String(columnsCsv || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  for (let attempt = 0; attempt < 40 && columns.length; attempt += 1) {
    const select = columns.join(', ');
    const result = await runSelect(select);
    if (!result.error) return result;

    if (!isMissingColumnError(result.error)) return result;

    const bad = columnFromSchemaError(result.error);
    if (!bad || !columns.includes(bad)) {
      console.error(`[webcart] ${label}: schema error but could not map column — ${result.error.message}`);
      return result;
    }
    console.warn(`[webcart] ${label}: live DB missing column "${bad}" — dropping and retrying (run pending migrations)`);
    columns = columns.filter((c) => c !== bad);
  }

  return { data: null, error: new Error(`${label}: no selectable columns left after schema fallback`) };
}

function phoneVariants(phone) {
  const digits = digitsOnly(phone);
  if (!digits) return [];
  const variants = new Set([digits]);
  if (digits.length === 10) variants.add(`91${digits}`);
  if (digits.length > 10) variants.add(digits.slice(-10));
  if (digits.startsWith('91') && digits.length === 12) variants.add(digits.slice(2));
  return [...variants];
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readHostSlug(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || req.hostname || '')
    .split(':')[0]
    .toLowerCase();
  const labels = host.split('.').filter(Boolean);
  if (!labels.length) return null;
  const first = labels[0];
  if (['www', 'api', 'app', 'localhost'].includes(first)) return null;
  return first;
}

function pickSupportPhone(restaurant) {
  return digitsOnly(
    restaurant?.whatsapp_number || restaurant?.contact_phone || restaurant?.manager_phone || ''
  );
}

function requiresShipping(lobType) {
  return SHIPPED_LOBS.has(String(lobType || '').toLowerCase());
}

function parsePincodeFromAddress(address) {
  const match = String(address || '').match(/\b(\d{6})\b/);
  return match ? match[1] : '';
}

function formatDeliveryAddress(address, pincode) {
  const addr = String(address || '').trim();
  const pin = normalizePincode(pincode);
  if (!addr) return '';
  if (pin && !addr.includes(pin)) return `${addr}, ${pin}`;
  return addr;
}

function buildSubmissionFingerprint({
  items,
  promo_code,
  special_request,
  total,
  delivery_address,
  pincode,
}) {
  const stableLines = (Array.isArray(items) ? items : [])
    .map((line) => ({
      id: String(line?.id || ''),
      qty: Number(line?.qty || 0),
      price: Number(line?.price || 0),
    }))
    .filter((line) => line.id && line.qty > 0)
    .sort((a, b) => a.id.localeCompare(b.id));

  const stablePayload = {
    items: stableLines,
    promo_code: String(promo_code || '').trim().toUpperCase(),
    special_request: String(special_request || '').trim(),
    delivery_address: String(delivery_address || '').trim(),
    pincode: normalizePincode(pincode),
    total: Number(total || 0),
  };

  return JSON.stringify(stablePayload);
}

function buildExpiredPayload(restaurant) {
  const supportPhone = pickSupportPhone(restaurant);
  const name = restaurant?.display_name || restaurant?.name || 'this restaurant';
  const lines = [
    `Your cart session has expired for ${name}.`,
    'Please return to WhatsApp and request a fresh cart link.',
  ];

  if (supportPhone) {
    lines.push(`Need help now? https://wa.me/${supportPhone}`);
  }

  return {
    valid: false,
    code: 'SESSION_EXPIRED',
    message: lines.join(' '),
    restaurant_name: name,
    support_phone: supportPhone || null,
  };
}

async function resolveRestaurantBySlug(req) {
  const slug = (req.query.slug || readHostSlug(req) || '').toString().trim().toLowerCase();

  const now = Date.now();
  let rows = _restaurantCache.rows;
  if (!rows || (now - _restaurantCache.fetchedAt) > RESTAURANT_CACHE_TTL_MS) {
    const TENANT_SELECT = [
      'id', 'name', 'display_name', 'slug', 'logo_url', 'contact_phone', 'manager_phone',
      'whatsapp_number', 'timezone', 'opening_hours', 'primary_slot_category',
      'parcel_charge_per_item', 'delivery_charge_default', 'delivery_charge_tiers',
      'gst_rate', 'kitchen_busy', 'lob_type', 'postal_code',
      'shiprocket_connected', 'shiprocket_api_key', 'shiprocket_email',
      'intra_city_charge', 'outstation_charge', 'free_delivery_above',
      'packaging_weight_grams', 'cod_enabled_city', 'cod_enabled_outstation',
      'shipping_provider', 'courier_name', 'courier_rate_card',
      'gstin', 'fssai_license', 'sac_code', 'receipt_tagline',
    ].join(', ');

    const { data, error } = await selectDroppingMissingColumns(
      'tenants',
      TENANT_SELECT,
      (select) => supabaseAdmin
        .from('tenants')
        .select(select)
        .eq('is_active', true)
        .limit(500),
    );
    if (error) throw error;
    rows = data || [];
    _restaurantCache = { rows, fetchedAt: now };
  }

  if (!slug) return rows[0] || null;

  const exact = rows.find((r) => {
    if (r.slug) return r.slug === slug;
    const variants = [slugify(r.display_name), slugify(r.name)].filter(Boolean);
    return variants.includes(slug);
  });

  return exact || rows[0] || null;
}

function minutesInTimezone(timezone) {
  const tz = timezone || 'Asia/Kolkata';
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const h = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const m = Number(parts.find(p => p.type === 'minute')?.value || 0);
  return { hour: h, minute: m, total: h * 60 + m };
}

function parseHm(hm, fallback) {
  const raw = String(hm || fallback || '00:00');
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  return h * 60 + mm;
}

function inWindow(minute, start, end) {
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

function isRestaurantLob(lobType) {
  return !lobType || lobType === 'restaurant';
}

async function fetchShiprocketRate({ apiKey, email, password, pickupPincode, deliveryPincode, weightKg = 0.5 }) {
  return fetchShiprocketCheapestRate({
    apiKey,
    email,
    password,
    pickupPincode,
    deliveryPincode,
    weightKg,
  });
}

/** Sum catalog weight_grams × qty → kg (see helpers/cartWeight.js). */
// cartWeightKg imported from helpers/cartWeight

async function calculateDelivery(restaurant, customerPincode, cartTotal, options = {}) {
  const tenantPincode = normalizePincode(restaurant?.postal_code);
  const customer = normalizePincode(customerPincode);
  const subtotal = Math.max(0, Number(cartTotal) || 0);
  const freeAbove = Number(restaurant?.free_delivery_above || 0);
  const provider = normalizeShippingProvider(restaurant?.shipping_provider);
  const courierZone = resolveCourierZone(tenantPincode, customer);
  const intraCity = courierZone === 'local';
  // Keep legacy zone labels for webcart UI; expose courier_zone for rate cards.
  const zone = intraCity ? 'intra_city' : 'outstation';
  let weightKg = 0.5;
  try {
    weightKg = Math.max(
      0.01,
      Number(options.weightKg) > 0
        ? Number(options.weightKg)
        : cartWeightKg(options.items, {
            packagingGrams: Number(restaurant?.packaging_weight_grams || 0) || 0,
          }),
    );
  } catch (weightErr) {
    console.warn('[webcart/delivery] weight calc failed, using 0.5kg:', weightErr.message);
    weightKg = 0.5;
  }
  const courierName = String(restaurant?.courier_name || '').trim() || null;

  const finish = (payload) => ({
    ...payload,
    charge: Math.round((Number(payload.charge) || 0) * 100) / 100,
    weight_kg: weightKg,
  });

  if (freeAbove > 0 && subtotal >= freeAbove) {
    return finish({
      zone,
      courier_zone: courierZone,
      courier_name: provider === 'custom' ? courierName : null,
      charge: 0,
      free_delivery_applied: true,
      cod_enabled: intraCity ? !!restaurant?.cod_enabled_city : !!restaurant?.cod_enabled_outstation,
      source: 'free_delivery_above',
      shipping_provider: provider,
    });
  }

  // Custom courier: weight × zone rate card for all destinations
  if (provider === 'custom') {
    let charge = null;
    let source = 'custom_rate_card';
    try {
      charge = chargeFromRateCard(restaurant?.courier_rate_card, courierZone, weightKg);
    } catch (cardErr) {
      console.warn('[webcart/delivery] rate card failed:', cardErr.message);
      charge = null;
    }
    if (charge == null) {
      charge = intraCity
        ? Number(restaurant?.intra_city_charge ?? restaurant?.delivery_charge_default ?? 0) || 0
        : Number(restaurant?.outstation_charge || 0) || 0;
      source = intraCity ? 'intra_city_flat' : 'outstation_flat';
    }
    return finish({
      zone,
      courier_zone: courierZone,
      courier_name: courierName,
      charge,
      free_delivery_applied: false,
      cod_enabled: intraCity ? !!restaurant?.cod_enabled_city : !!restaurant?.cod_enabled_outstation,
      source,
      shipping_provider: provider,
    });
  }

  // Default: Shiprocket for outstation; flat intra-city
  if (intraCity) {
    const charge = Number(restaurant?.intra_city_charge ?? restaurant?.delivery_charge_default ?? 0) || 0;
    return finish({
      zone,
      courier_zone: courierZone,
      courier_name: null,
      charge,
      free_delivery_applied: false,
      cod_enabled: !!restaurant?.cod_enabled_city,
      source: 'intra_city_flat',
      shipping_provider: provider,
    });
  }

  let charge = Number(restaurant?.outstation_charge || 0) || 0;
  let source = 'outstation_flat';
  const useShiprocket = (restaurant?.shiprocket_api_key || restaurant?.shiprocket_email)
    && tenantPincode
    && customer;
  if (useShiprocket) {
    try {
      const shiprocketRate = await fetchShiprocketRate({
        apiKey: restaurant.shiprocket_api_key,
        email: restaurant.shiprocket_email,
        password: restaurant.shiprocket_api_key,
        pickupPincode: tenantPincode,
        deliveryPincode: customer,
        weightKg,
      });
      if (shiprocketRate != null) {
        charge = shiprocketRate;
        source = 'shiprocket';
      }
    } catch (srErr) {
      console.warn('[webcart/delivery] Shiprocket quote failed, using flat fallback:', srErr.message);
    }
  }

  return finish({
    zone,
    courier_zone: courierZone,
    courier_name: null,
    charge,
    free_delivery_applied: false,
    cod_enabled: !!restaurant?.cod_enabled_outstation,
    source,
    shipping_provider: provider,
  });
}

function resolveCurrentSlot(restaurant) {
  const opening = restaurant?.opening_hours || {};
  const { hour, total } = minutesInTimezone(restaurant?.timezone || 'Asia/Kolkata');
  const lob = restaurant?.lob_type || 'restaurant';

  // Packaged / retail LOBs: accept orders anytime (no meal slots / open-close window)
  if (lob && lob !== 'restaurant') {
    return { current_slot: 'anytime', slot_state: 'open', hour };
  }

  const tiffinEnabled = opening.breakfast !== false;
  const lunchEnabled = opening.lunch !== false;
  const dinnerEnabled = opening.dinner !== false;

  const tiffin = { start: parseHm(opening.breakfast_start, '06:00'), end: parseHm(opening.breakfast_end, '11:00') };
  const lunch = { start: parseHm(opening.lunch_start, '12:00'), end: parseHm(opening.lunch_end, '15:00') };
  const dinner = { start: parseHm(opening.dinner_start, '19:00'), end: parseHm(opening.dinner_end, '23:00') };

  if (tiffinEnabled && inWindow(total, tiffin.start, tiffin.end)) return { current_slot: 'tiffin', slot_state: 'open', hour };
  if (lunchEnabled && inWindow(total, lunch.start, lunch.end)) return { current_slot: 'lunch', slot_state: 'open', hour };
  if (dinnerEnabled && inWindow(total, dinner.start, dinner.end)) return { current_slot: 'dinner', slot_state: 'open', hour };

  if (hour >= 23 || hour < 6) {
    return {
      current_slot: null,
      slot_state: 'closed',
      hour,
      banner: 'Kitchen is closed right now — browse and schedule for later.',
    };
  }

  return {
    current_slot: null,
    slot_state: 'gap',
    hour,
    banner: 'No active meal slot right now — browse all items or schedule for later.',
  };
}

function normalizeSlots(input) {
  const allowed = new Set(['tiffin', 'lunch', 'dinner', 'anytime']);
  const slots = Array.isArray(input) ? input : [];
  const clean = [...new Set(slots.map(v => String(v || '').toLowerCase().trim()).filter(Boolean))]
    .filter(v => allowed.has(v));
  if (!clean.length) return ['anytime'];
  // anytime = all day; never combine with specific meal slots
  if (clean.includes('anytime')) return ['anytime'];
  return clean;
}

// Keep walk-in "active" window aligned with menu_tokens default TTL (24h).
const WALK_IN_ACTIVE_MS = 1000 * 60 * 60 * 24;

function isActiveWalkInRow(data) {
  if (!data) return false;
  if (!ACTIVE_TOKEN_STATUSES.has(data.status) || data.completed_at) return false;
  const arrivedAt = data.arrived_at ? new Date(data.arrived_at) : null;
  const ageMs = arrivedAt ? Date.now() - arrivedAt.getTime() : Number.POSITIVE_INFINITY;
  if (!arrivedAt || ageMs > WALK_IN_ACTIVE_MS) return false;
  return true;
}

/**
 * Soft session from a still-valid menu_tokens row when the linked walk-in is
 * gone/completed. Packaged LOBs (food_products etc.) reuse the same WhatsApp
 * menu link across orders — requiring a live walk-in made every revisit look
 * "expired" even while menu_tokens.expires_at was still in the future.
 */
function menuTokenSoftSession(menuToken, fallbackPhone, { shipped = false } = {}) {
  const phone = String(menuToken?.phone || fallbackPhone || '').trim();
  if (!phone) return null;
  const kind = shipped ? 'delivery' : 'takeaway';
  return {
    id: String(menuToken.walk_in_token_id || menuToken.session_token || '').trim() || null,
    phone,
    status: kind,
    type: kind,
    arrived_at: new Date().toISOString(),
    completed_at: null,
    meta: {
      source: 'menu_token_soft_session',
      session_token: menuToken.session_token || null,
      soft_session: true,
      service_type: kind,
    },
    _soft: true,
  };
}

async function resolveSession({ restaurantId, token, phone, allowSoftMenuSession = false, preferDelivery = false }) {
  const rawVariants = phoneVariants(phone);
  if (!restaurantId || !token) return null;

  let menuToken = null;
  let menuTokensTableMissing = false;
  try {
    let menuQuery = supabaseAdmin
      .from('menu_tokens')
      .select('session_token, phone, walk_in_token_id, expires_at, is_active')
      .eq('restaurant_id', restaurantId)
      .eq('session_token', token)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .limit(1);

    if (rawVariants.length) {
      menuQuery = menuQuery.in('phone', rawVariants);
    }

    const { data: menuData, error: menuErr } = await menuQuery.maybeSingle();

    if (menuErr) {
      const raw = `${menuErr.code || ''} ${menuErr.message || ''}`.toLowerCase();
      const missingTable = raw.includes('menu_tokens') || raw.includes('pgrst205') || raw.includes('42p01');
      if (!missingTable) throw menuErr;
      menuTokensTableMissing = true;
    } else {
      menuToken = menuData || null;
    }
  } catch (err) {
    throw err;
  }

  const tokenPhone = menuToken?.phone || '';
  const variants = rawVariants.length ? rawVariants : phoneVariants(tokenPhone);
  if (!variants.length) return null;

  // ── Primary path: menu_tokens row exists for this URL token ──────────────
  // Never fall back to "latest walk_in by phone" here. That silently binds a
  // scheduled-delivery menu link to a stale takeaway token (e.g. T-2607-132)
  // and webcart then treats the order as immediate takeaway.
  if (menuToken) {
    const walkTokenId = String(menuToken.walk_in_token_id || '').trim();
    if (!walkTokenId) {
      if (allowSoftMenuSession) {
        return menuTokenSoftSession(menuToken, variants[0], { shipped: preferDelivery });
      }
      console.error(
        '[webcart/session] menu_tokens row missing walk_in_token_id — refusing phone fallback',
        { restaurantId, token: String(token).slice(0, 12), phone: variants[0] }
      );
      return null;
    }

    // Prefer exact id; phone filter is a safety check, not the identity key.
    let { data: byId, error } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('id, phone, status, arrived_at, completed_at, meta, type')
      .eq('restaurant_id', restaurantId)
      .eq('id', walkTokenId)
      .in('phone', variants)
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    if (!byId) {
      // Retry without phone filter when variants mismatch (91 vs 10-digit).
      const byIdOnly = await supabaseAdmin
        .from('walk_in_tokens')
        .select('id, phone, status, arrived_at, completed_at, meta, type')
        .eq('restaurant_id', restaurantId)
        .eq('id', walkTokenId)
        .limit(1)
        .maybeSingle();
      if (byIdOnly.error) throw byIdOnly.error;
      byId = byIdOnly.data || null;
      if (byId && !phoneVariants(byId.phone).some((p) => variants.includes(p))) {
        console.error(
          '[webcart/session] walk_in_token_id phone mismatch — refusing to bind',
          { restaurantId, walkTokenId, menuPhone: variants[0], walkPhone: byId.phone }
        );
        return allowSoftMenuSession ? menuTokenSoftSession(menuToken, variants[0], { shipped: preferDelivery }) : null;
      }
    }

    if (!byId) {
      if (allowSoftMenuSession) {
        return menuTokenSoftSession(menuToken, variants[0], { shipped: preferDelivery });
      }
      console.error(
        '[webcart/session] menu_tokens.walk_in_token_id not found — refusing phone fallback',
        { restaurantId, walkTokenId, phone: variants[0] }
      );
      return null;
    }

    if (!isActiveWalkInRow(byId)) {
      if (allowSoftMenuSession) {
        // Menu link itself is still valid — keep checkout usable for packaged LOBs.
        const kind = preferDelivery ? 'delivery' : 'takeaway';
        return {
          ...byId,
          status: preferDelivery ? 'delivery' : (ACTIVE_TOKEN_STATUSES.has(byId.status) ? byId.status : 'takeaway'),
          type: preferDelivery ? 'delivery' : (byId.type || 'takeaway'),
          completed_at: null,
          meta: {
            ...(typeof byId.meta === 'object' && byId.meta ? byId.meta : {}),
            soft_session: true,
            source: 'menu_token_stale_walk_in',
            service_type: preferDelivery
              ? 'delivery'
              : (byId.meta?.service_type || byId.type || 'takeaway'),
          },
          _soft: true,
        };
      }
      console.error(
        '[webcart/session] linked walk_in token inactive/stale — refusing phone fallback',
        {
          restaurantId,
          walkTokenId,
          status: byId.status,
          type: byId.type,
          completed_at: byId.completed_at,
        }
      );
      return null;
    }

    return byId;
  }

  // ── Legacy path: no menu_tokens row (old links / table not migrated) ─────
  // Resolve only by explicit walk-in id == URL token. Do not grab "latest by phone".
  if (!menuTokensTableMissing) {
    console.warn(
      '[webcart/session] no active menu_tokens row for session_token — trying legacy id match only',
      { restaurantId, token: String(token).slice(0, 12), phone: variants[0] }
    );
  }

  const { data: legacyById, error: legacyErr } = await supabaseAdmin
    .from('walk_in_tokens')
    .select('id, phone, status, arrived_at, completed_at, meta, type')
    .eq('restaurant_id', restaurantId)
    .eq('id', token)
    .in('phone', variants)
    .limit(1)
    .maybeSingle();
  if (legacyErr) throw legacyErr;

  if (!isActiveWalkInRow(legacyById)) return null;
  return legacyById;
}

// Restaurant LOBs (Munafe etc.) never use PSL/catalog fields — selecting them
// breaks PostgREST when those columns are not migrated (e.g. scoop_count).
const RESTAURANT_MENU_ITEM_SELECT =
  'id, retailer_id, name, price, category, description, image_url, image_url_2, image_url_3, image_url_4, image_url_5, is_special_today, is_todays_special, special_note, applicable_slots, is_stocked, is_available, discount_percent, discount_ends_at';

const CATALOG_MENU_ITEM_SELECT =
  `${RESTAURANT_MENU_ITEM_SELECT}, variant_group_id, size_label, item_type, flavour_group, scoop_count, crust_options, toppings_allowed, topping_extra_price, pack_size_label, weight_grams, shelf_life_days, made_on_date, ingredients, allergens, condition, original_mrp, warranty_days, colour, meta, current_stock, availability_status, launch_at, deposit_amount`;

// Single source of truth for "can this item actually be bought right now" —
// used both when rendering the storefront AND when validating checkout server-side,
// so a coming-soon / preorder / sold-out item can never slip through the API
// even if the client sends a stale cart.
function deriveStockStatus(item) {
  const qtyOk = item.current_stock == null || Number(item.current_stock) > 0;
  const status = String(item.availability_status || '').toLowerCase().trim();
  const comingSoon = status === 'coming_soon' || status === 'preorder';
  const soldOutStatus = status === 'sold_out';
  const stocked = comingSoon ? false : (!!item.is_stocked && qtyOk && !soldOutStatus);
  return { stocked, comingSoon, status: status || (stocked ? 'in_stock' : 'sold_out') };
}

async function fetchMenuItems(restaurantId, { catalogLob = false } = {}) {
  const cacheKey = `${restaurantId}:${catalogLob ? 'catalog' : 'restaurant'}`;
  const cached = _menuCache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.fetchedAt) <= MENU_CACHE_TTL_MS) {
    return { items: cached.items, categorySlotMap: cached.categorySlotMap };
  }

  const itemColumns = catalogLob ? CATALOG_MENU_ITEM_SELECT : RESTAURANT_MENU_ITEM_SELECT;

  const [itemsRes, categoriesRes] = await Promise.all([
    selectDroppingMissingColumns(
      `menu_items:${catalogLob ? 'catalog' : 'restaurant'}`,
      itemColumns,
      (select) => supabaseAdmin
        .from('menu_items')
        .select(select)
        .eq('restaurant_id', restaurantId)
        .is('archived_at', null)
        .order('category', { ascending: true })
        .order('name', { ascending: true }),
    ),
    supabaseAdmin
      .from('menu_categories')
      .select('name, applicable_slots')
      .eq('restaurant_id', restaurantId),
  ]);

  if (itemsRes.error) throw itemsRes.error;

  let categoryRows = [];
  if (categoriesRes.error) {
    const raw = `${categoriesRes.error.code || ''} ${categoriesRes.error.message || ''}`.toLowerCase();
    const missingTable = raw.includes('menu_categories') || raw.includes('pgrst205') || raw.includes('42p01');
    if (!missingTable) throw categoriesRes.error;
  } else {
    categoryRows = categoriesRes.data || [];
  }

  const categorySlotMap = Object.fromEntries(
    categoryRows.map(row => [row.name, normalizeSlots(row.applicable_slots)])
  );

  const items = (itemsRes.data || []).map(item => {
    const { stocked, comingSoon, status } = deriveStockStatus(item);
    const discount = deriveMenuDiscount(item);
    return {
      ...item,
      is_available: !!item.is_available,
      is_stocked: stocked,
      current_stock: item.current_stock == null ? null : Number(item.current_stock),
      availability_status: status,
      is_coming_soon: comingSoon,
      is_publicly_available: !!(item.is_available && stocked && !comingSoon),
      effective_slots: normalizeSlots(item.applicable_slots || categorySlotMap[item.category] || ['anytime']),
      is_todays_special: !!(item.is_todays_special || item.is_special_today),
      list_price: discount.list_price,
      price: discount.effective_price,
      base_price: discount.list_price,
      effective_price: discount.effective_price,
      discount_active: discount.discount_active,
      discount_percent: discount.discount_active ? discount.discount_percent : null,
      discount_ends_at: discount.discount_active ? discount.discount_ends_at : null,
      discount_days_left: discount.discount_days_left,
      discount_hours_left: discount.discount_hours_left,
    };
  });

  _menuCache.set(cacheKey, { items, categorySlotMap, fetchedAt: now });

  return { items, categorySlotMap };
}

async function triggerConfirmAndPay(payload) {
  const secret = getKdsSecret();
  const response = await fetch(`${CHAT_SERVICE_URL}/internal/webcart-confirm-pay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': secret,
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
  });

  let data = {};
  try {
    data = await response.json();
  } catch (_) {
    data = {};
  }

  if (!response.ok || !data.ok) {
    const err = new Error(data.error || `Chat service error (${response.status})`);
    err.response = data;
    throw err;
  }

  return data;
}


const SHIPROCKET_STATUS_MAP = {
  pickup_scheduled: 'Pickup scheduled',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
};

async function triggerShipmentNotify(payload) {
  const secret = getKdsSecret();
  const response = await fetch(`${CHAT_SERVICE_URL}/internal/shipment-notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': secret,
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
  });
  let data = {};
  try {
    data = await response.json();
  } catch (_) {
    data = {};
  }
  if (!response.ok || !data.ok) {
    const err = new Error(data.error || `Chat service error (${response.status})`);
    err.response = data;
    throw err;
  }
  return data;
}

module.exports = {
  path,
  supabaseAdmin,
  getKdsSecret,
  normalizePincode,
  resolveCourierZone,
  chargeFromRateCard,
  normalizeShippingProvider,
  fetchShiprocketCheapestRate,
  getAffinityForWebcart,
  cartWeightKg,
  resolveCartLineWeights,
  deductStockForLines,
  joinStockWaitlist,
  deriveMenuDiscount,
  ACTIVE_TOKEN_STATUSES,
  DEFAULT_THEME,
  CHAT_SERVICE_URL,
  SHIPPED_LOBS,
  RESTAURANT_CACHE_TTL_MS,
  MENU_CACHE_TTL_MS,
  digitsOnly,
  isMissingColumnError,
  columnFromSchemaError,
  selectDroppingMissingColumns,
  phoneVariants,
  slugify,
  readHostSlug,
  pickSupportPhone,
  requiresShipping,
  parsePincodeFromAddress,
  formatDeliveryAddress,
  buildSubmissionFingerprint,
  buildExpiredPayload,
  resolveRestaurantBySlug,
  minutesInTimezone,
  parseHm,
  inWindow,
  isRestaurantLob,
  fetchShiprocketRate,
  calculateDelivery,
  resolveCurrentSlot,
  normalizeSlots,
  WALK_IN_ACTIVE_MS,
  isActiveWalkInRow,
  menuTokenSoftSession,
  resolveSession,
  deriveStockStatus,
  fetchMenuItems,
  triggerConfirmAndPay,
  SHIPROCKET_STATUS_MAP,
  triggerShipmentNotify,
};
