'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');

const { supabaseAdmin } = require('../config/supabase');
const { getKdsSecret } = require('../config/internalSecret');
const {
  normalizePincode,
  resolveCourierZone,
  chargeFromRateCard,
  normalizeShippingProvider,
} = require('../helpers/courierRates');
const { fetchShiprocketCheapestRate } = require('../helpers/shiprocket');
const { getAffinityForWebcart } = require('../helpers/productAffinity');
const {
  cartWeightKg,
  resolveCartLineWeights,
} = require('../helpers/cartWeight');
const {
  deductStockForLines,
  joinStockWaitlist,
} = require('../helpers/inventory');

const ACTIVE_TOKEN_STATUSES = new Set(['waiting', 'pending_approval', 'seated', 'takeaway']);
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
    const { data, error } = await supabaseAdmin
      .from('tenants')
      .select('id, name, display_name, logo_url, contact_phone, manager_phone, whatsapp_number, timezone, opening_hours, primary_slot_category, parcel_charge_per_item, delivery_charge_default, delivery_charge_tiers, gst_rate, kitchen_busy, lob_type, postal_code, shiprocket_connected, shiprocket_api_key, shiprocket_email, intra_city_charge, outstation_charge, free_delivery_above, packaging_weight_grams, cod_enabled_city, cod_enabled_outstation, shipping_provider, courier_name, courier_rate_card, gstin, fssai_license, sac_code, receipt_tagline')
      .eq('is_active', true)
      .limit(500);
    if (error) throw error;
    rows = data || [];
    _restaurantCache = { rows, fetchedAt: now };
  }

  if (!slug) return rows[0] || null;

  const exact = rows.find((r) => {
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
  const subtotal = Math.max(0, Number(cartTotal || 0));
  const freeAbove = Number(restaurant?.free_delivery_above || 0);
  const provider = normalizeShippingProvider(restaurant?.shipping_provider);
  const courierZone = resolveCourierZone(tenantPincode, customer);
  const intraCity = courierZone === 'local';
  // Keep legacy zone labels for webcart UI; expose courier_zone for rate cards.
  const zone = intraCity ? 'intra_city' : 'outstation';
  const weightKg = Math.max(
    0.01,
    Number(options.weightKg) > 0
      ? Number(options.weightKg)
      : cartWeightKg(options.items, {
          packagingGrams: Number(restaurant?.packaging_weight_grams || 0) || 0,
        }),
  );
  const courierName = String(restaurant?.courier_name || '').trim() || null;

  if (freeAbove > 0 && subtotal >= freeAbove) {
    return {
      zone,
      courier_zone: courierZone,
      courier_name: provider === 'custom' ? courierName : null,
      charge: 0,
      free_delivery_applied: true,
      cod_enabled: intraCity ? !!restaurant?.cod_enabled_city : !!restaurant?.cod_enabled_outstation,
      source: 'free_delivery_above',
      shipping_provider: provider,
      weight_kg: weightKg,
    };
  }

  // Custom courier: weight × zone rate card for all destinations
  if (provider === 'custom') {
    let charge = chargeFromRateCard(restaurant?.courier_rate_card, courierZone, weightKg);
    let source = 'custom_rate_card';
    if (charge == null) {
      charge = intraCity
        ? Number(restaurant?.intra_city_charge ?? restaurant?.delivery_charge_default ?? 0) || 0
        : Number(restaurant?.outstation_charge || 0) || 0;
      source = intraCity ? 'intra_city_flat' : 'outstation_flat';
    }
    return {
      zone,
      courier_zone: courierZone,
      courier_name: courierName,
      charge: Math.round(charge * 100) / 100,
      free_delivery_applied: false,
      cod_enabled: intraCity ? !!restaurant?.cod_enabled_city : !!restaurant?.cod_enabled_outstation,
      source,
      shipping_provider: provider,
      weight_kg: weightKg,
    };
  }

  // Default: Shiprocket for outstation; flat intra-city
  if (intraCity) {
    const charge = Number(restaurant?.intra_city_charge ?? restaurant?.delivery_charge_default ?? 0) || 0;
    return {
      zone,
      courier_zone: courierZone,
      courier_name: null,
      charge: Math.round(charge * 100) / 100,
      free_delivery_applied: false,
      cod_enabled: !!restaurant?.cod_enabled_city,
      source: 'intra_city_flat',
      shipping_provider: provider,
      weight_kg: weightKg,
    };
  }

  let charge = Number(restaurant?.outstation_charge || 0) || 0;
  let source = 'outstation_flat';
  const useShiprocket = (restaurant?.shiprocket_api_key || restaurant?.shiprocket_email)
    && tenantPincode
    && customer;
  if (useShiprocket) {
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
  }

  return {
    zone,
    courier_zone: courierZone,
    courier_name: null,
    charge: Math.round(charge * 100) / 100,
    free_delivery_applied: false,
    cod_enabled: !!restaurant?.cod_enabled_outstation,
    source,
    shipping_provider: provider,
    weight_kg: weightKg,
  };
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

function isActiveWalkInRow(data) {
  if (!data) return false;
  if (!ACTIVE_TOKEN_STATUSES.has(data.status) || data.completed_at) return false;
  const arrivedAt = data.arrived_at ? new Date(data.arrived_at) : null;
  const ageMs = arrivedAt ? Date.now() - arrivedAt.getTime() : Number.POSITIVE_INFINITY;
  if (!arrivedAt || ageMs > 1000 * 60 * 60 * 12) return false;
  return true;
}

async function resolveSession({ restaurantId, token, phone }) {
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
        return null;
      }
    }

    if (!byId) {
      console.error(
        '[webcart/session] menu_tokens.walk_in_token_id not found — refusing phone fallback',
        { restaurantId, walkTokenId, phone: variants[0] }
      );
      return null;
    }

    if (!isActiveWalkInRow(byId)) {
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
  'id, retailer_id, name, price, category, description, image_url, image_url_2, image_url_3, image_url_4, image_url_5, is_special_today, is_todays_special, special_note, applicable_slots, is_stocked, is_available';

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
    supabaseAdmin
      .from('menu_items')
      .select(itemColumns)
      .eq('restaurant_id', restaurantId)
      .is('archived_at', null)
      .order('category', { ascending: true })
      .order('name', { ascending: true }),
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

router.get('/api/webcart/session', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    const phone = String(req.query.phone || '').trim();
    const guestMode = String(req.query.guest || '').trim() === '1'
      || String(req.query.mode || '').trim().toLowerCase() === 'shop';

    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) {
      return res.status(404).json({
        valid: false,
        code: 'RESTAURANT_NOT_FOUND',
        message: 'Restaurant not found.',
      });
    }

    const lobType = restaurant.lob_type || 'restaurant';
    const catalogLob = !isRestaurantLob(lobType);

    // Permanent storefront: packaged LOBs can browse without WhatsApp token.
    if ((!token || !phone) && !(guestMode && catalogLob)) {
      return res.status(400).json({
        valid: false,
        code: 'BAD_REQUEST',
        message: catalogLob
          ? 'Open /shop?slug=… for the public storefront, or provide token and phone.'
          : 'token and phone are required.',
      });
    }

    const session = (token && phone)
      ? await resolveSession({
          restaurantId: restaurant.id,
          token,
          phone,
        })
      : null;

    const { items: menuItems, categorySlotMap } = await fetchMenuItems(restaurant.id, { catalogLob });

    let slotInfo;
    let availableNow;
    let preferredCategory = null;

    if (catalogLob) {
      slotInfo = {
        current_slot: null,
        slot_state: 'open',
        banner: null,
        catalog_lob: true,
      };
      availableNow = [];
    } else {
      slotInfo = resolveCurrentSlot(restaurant);

      // Manager portal "Kitchen: Open" override (POST /api/catalog/kitchen-toggle
      // in src/routes/catalog.js) works by flipping menu_items.is_available — it
      // never touches restaurant.opening_hours, which is all resolveCurrentSlot()
      // above looks at. So outside scheduled hours the web menu kept showing
      // "Kitchen is closed" even after the manager explicitly opened it, while
      // the WhatsApp bot (chat/tools/kitchen_hours.py → has_manager_kitchen_override)
      // already honored the same signal. Detect it here the same way so both
      // channels agree.
      const managerOverrideItems = menuItems.filter(i => i.is_available);
      const managerOverrideActive = slotInfo.slot_state !== 'open' && managerOverrideItems.length > 0;
      if (managerOverrideActive) {
        slotInfo = { ...slotInfo, slot_state: 'open', manager_override: true, banner: null };
      }

      availableNow = !slotInfo.current_slot && managerOverrideActive
        ? managerOverrideItems
        : slotInfo.current_slot
          ? menuItems.filter(i => i.effective_slots.includes('anytime') || i.effective_slots.includes(slotInfo.current_slot))
          : [];

      const primarySlotMap = restaurant?.primary_slot_category || {};
      preferredCategory = slotInfo.current_slot
        ? String(primarySlotMap?.[slotInfo.current_slot] || '').trim() || null
        : null;
    }

    const todaysSpecial = catalogLob ? [] : menuItems.filter(i => i.is_todays_special);

    const isGuest = !session && catalogLob && (!token || !phone);
    const sessionPayload = session
      ? {
          token: session.id,
          phone: session.phone,
          type: session.type,
        }
      : isGuest
        ? {
            token: 'guest',
            phone: '',
            type: 'delivery',
            guest: true,
          }
        : {
            token,
            phone,
            type: 'takeaway',
          };

    const orderingEnabled = true;

    let affinity = {
      updated_at: null,
      by_item: {},
      pairs: [],
      customer_favourites: [],
    };
    try {
      affinity = await getAffinityForWebcart(supabaseAdmin, restaurant.id, {
        phone: session?.phone || phone || null,
      });
    } catch (affErr) {
      console.warn('[webcart/session] affinity:', affErr.message);
    }

    const storefrontSlug = slugify(restaurant.display_name || restaurant.name) || null;

    return res.json({
      valid: true,
      ordering_enabled: orderingEnabled,
      session_expired: !session && !isGuest,
      guest_storefront: isGuest,
      storefront_url: storefrontSlug ? `/shop?slug=${encodeURIComponent(storefrontSlug)}` : null,
      restaurant: {
        id: restaurant.id,
        name: restaurant.display_name || restaurant.name,
        logo_url: restaurant.logo_url || null,
        support_phone: pickSupportPhone(restaurant) || null,
        lob_type: lobType,
        gstin: restaurant.gstin || null,
        fssai_license: restaurant.fssai_license || null,
        sac_code: restaurant.sac_code || null,
        receipt_tagline: restaurant.receipt_tagline || null,
      },
      pricing_config: {
        parcel_charge_per_item: restaurant.parcel_charge_per_item || 0,
        gst_rate: restaurant.gst_rate || 5,
        delivery_charge_default: restaurant.delivery_charge_default || 40,
        free_delivery_above: Number(restaurant.free_delivery_above) > 0
          ? Number(restaurant.free_delivery_above)
          : 0,
        packaging_weight_grams: Number(restaurant.packaging_weight_grams) > 0
          ? Number(restaurant.packaging_weight_grams)
          : 0,
      },
      affinity,
      
      theme: DEFAULT_THEME,
      session: sessionPayload,
      menu_items: menuItems,
      todays_special: todaysSpecial,
      available_now: availableNow,
      current_slot: slotInfo.current_slot,
      slot_state: slotInfo.slot_state,
      slot_banner: slotInfo.banner || null,
      catalog_lob: catalogLob,
      kitchen_manual_override: !!slotInfo.manager_override,
      kitchen_busy: !!restaurant.kitchen_busy,
      preferred_category: preferredCategory,
      category_slots: categorySlotMap,
      promotions: [],
      session_message: isGuest
        ? 'Browse the storefront. Enter your WhatsApp number at checkout to place the order.'
        : (session
          ? null
          : 'Your WhatsApp session expired, but the menu is still available to browse. Please request a fresh link to submit an order.'),
    });
  } catch (err) {
    console.error('[webcart/session]', err.message);
    return res.status(500).json({ valid: false, code: 'SERVER_ERROR', message: 'Failed to load cart session.' });
  }
});

router.get('/api/webcart/payment-status', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    const phone = String(req.query.phone || '').trim();
    const orderRefFilter = String(req.query.order_ref || '').trim();
    const bookingIdFilter = String(req.query.booking_id || '').trim();

    if ((!token || !phone) && !bookingIdFilter) {
      return res.status(400).json({ ok: false, error: 'token/phone or booking_id is required.' });
    }

    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found.' });

    let bookingId = bookingIdFilter;
    let submission = null;

    if (token && phone) {
      const session = await resolveSession({
        restaurantId: restaurant.id,
        token,
        phone,
      });

      if (session) {
        submission = session?.meta?.web_cart_submission || null;
        bookingId = bookingId || String(submission?.booking_id || '').trim();
      }
    }

    if (!submission && bookingId) {
      const { data: bookingRow, error: bookingErr } = await supabaseAdmin
        .from('bookings')
        .select('id, meta, status, payment_status')
        .eq('restaurant_id', restaurant.id)
        .eq('id', bookingId)
        .limit(1)
        .maybeSingle();
      if (bookingErr) throw bookingErr;

      const meta = bookingRow?.meta || {};
      submission = meta?.web_cart_submission || null;
      if (!submission) {
        return res.json({
          ok: true,
          has_active_submission: false,
          paid: String(bookingRow?.payment_status || '').toLowerCase() === 'paid' || String(bookingRow?.status || '').toLowerCase() === 'confirmed',
          status: 'booking_lookup_only',
          booking_id: bookingId,
        });
      }
    }

    if (!submission) {
      return res.json({
        ok: true,
        has_active_submission: false,
        paid: false,
        status: 'no_submission',
      });
    }

    const submissionOrderRef = String(submission.order_ref || '').trim();
    if (orderRefFilter && submissionOrderRef && submissionOrderRef !== orderRefFilter) {
      return res.json({
        ok: true,
        has_active_submission: false,
        paid: false,
        status: 'stale_submission',
      });
    }

    bookingId = String(submission.booking_id || bookingId || '').trim();
    if (!bookingId) {
      return res.json({
        ok: true,
        has_active_submission: true,
        paid: false,
        status: 'booking_pending',
        order_ref: submissionOrderRef || null,
      });
    }

    const { data: booking, error: bookingErr } = await supabaseAdmin
      .from('bookings')
      .select('id, status, payment_status')
      .eq('restaurant_id', restaurant.id)
      .eq('id', bookingId)
      .limit(1)
      .maybeSingle();
    if (bookingErr) throw bookingErr;

    const bookingStatus = String(booking?.status || '').trim().toLowerCase();
    const paymentStatus = String(booking?.payment_status || '').trim().toLowerCase();
    const paid = paymentStatus === 'paid' || bookingStatus === 'confirmed';

    return res.json({
      ok: true,
      has_active_submission: true,
      booking_id: bookingId,
      order_ref: submissionOrderRef || null,
      paid,
      booking_status: bookingStatus || null,
      payment_status: paymentStatus || null,
      updated_at: null,
    });
  } catch (err) {
    console.error('[webcart/payment-status]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to fetch payment status.' });
  }
});

router.post('/api/webcart/submit', async (req, res) => {
  try {
    const {
      token,
      phone,
      items,
      special_request,
      promo_code,
      customer_name,
      delivery_address,
      pincode,
    } = req.body || {};
    const safeToken = String(token || '').trim();
    const safePhone = String(phone || '').trim();
    const guestCheckout = String(req.body?.guest || '').trim() === '1'
      || safeToken === 'guest'
      || !safeToken;

    if (!safePhone || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ ok: false, error: 'phone and at least one item are required.' });
    }
    if (!guestCheckout && !safeToken) {
      return res.status(400).json({ ok: false, error: 'token, phone, and at least one item are required.' });
    }

    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found.' });

    const catalogLob = !isRestaurantLob(restaurant.lob_type);
    if (guestCheckout && !catalogLob) {
      return res.status(400).json({ ok: false, error: 'Guest checkout is only available on packaged storefronts.' });
    }

    // Server-side FSSAI gate — defense in depth in case a row was published
    // before the license was on file, or was set stocked via an older client.
    const needsFssai = String(restaurant.lob_type || '').toLowerCase() === 'food_products'
      && !String(restaurant.fssai_license || '').trim();
    if (needsFssai) {
      return res.status(409).json({
        ok: false,
        error: 'This store cannot accept orders yet — FSSAI license is missing on file.',
      });
    }

    const shippedOrder = requiresShipping(restaurant.lob_type);
    const safeName = String(customer_name || '').trim();
    const safeAddress = String(delivery_address || '').trim();
    const safePincode = normalizePincode(pincode);

    if (shippedOrder) {
      if (!safeName) {
        return res.status(400).json({ ok: false, error: 'Customer name is required for delivery orders.' });
      }
      if (!safeAddress) {
        return res.status(400).json({ ok: false, error: 'Delivery address is required.' });
      }
      if (!safePincode) {
        return res.status(400).json({ ok: false, error: 'A valid 6-digit pincode is required.' });
      }
    }

    const session = (!guestCheckout && safeToken)
      ? await resolveSession({
          restaurantId: restaurant.id,
          token: safeToken,
          phone: safePhone,
        })
      : null;

    const { data: liveItems, error: liveErr } = await supabaseAdmin
      .from('menu_items')
      .select('id, retailer_id, name, price, weight_grams, item_type, meta, current_stock, is_stocked, availability_status')
      .eq('restaurant_id', restaurant.id)
      .is('archived_at', null);

    if (liveErr) throw liveErr;

    const liveMap = new Map();
    for (const row of (liveItems || [])) {
      liveMap.set(String(row.id), row);
      if (row.retailer_id) liveMap.set(String(row.retailer_id), row);
    }

    const unavailable = [];
    const shortages = [];
    for (const i of items) {
      const source = liveMap.get(String(i.id || ''));
      if (!source || !deriveStockStatus(source).stocked) {
        if (i.name) unavailable.push(i.name);
        continue;
      }
      const qty = Math.max(0, Math.floor(Number(i.qty || 0)));
      if (source.current_stock != null && qty > Number(source.current_stock)) {
        shortages.push({
          name: source.name,
          asked: qty,
          available: Number(source.current_stock),
        });
      }
    }

    if (unavailable.length) {
      const label = unavailable.slice(0, 3).join(', ');
      return res.status(409).json({
        ok: false,
        error: `${label} ${unavailable.length > 1 ? 'are' : 'is'} no longer available — please remove ${unavailable.length > 1 ? 'them' : 'it'} to continue.`,
        unavailable_items: unavailable,
      });
    }

    if (shortages.length) {
      const s = shortages[0];
      return res.status(409).json({
        ok: false,
        error: `Only ${s.available} left of ${s.name} (you asked for ${s.asked}).`,
        shortages,
      });
    }

    const weightedLines = resolveCartLineWeights(items, liveItems || []);
    const weightByKey = new Map(weightedLines.map((l) => [String(l.id), l.weight_grams]));

    const normalizedItems = [];
    const stockLines = [];
    for (const row of items) {
      const source = liveMap.get(String(row.id || ''));
      if (!source || !deriveStockStatus(source).stocked) continue;

      const qty = Math.max(0, Math.floor(Number(row.qty || 0)));
      if (!qty) continue;

      const unitPrice = Number(source.price || 0);
      const key = source.retailer_id || source.id;
      normalizedItems.push({
        id: key,
        name: source.name,
        qty,
        price: unitPrice,
        line_total: unitPrice * qty,
        weight_grams: Number(
          weightByKey.get(String(row.id))
          ?? weightByKey.get(String(key))
          ?? source.weight_grams
          ?? 0,
        ) || 0,
      });
      stockLines.push({
        menu_item_id: source.id,
        id: source.id,
        qty,
        name: source.name,
      });
    }

    if (!normalizedItems.length) {
      return res.status(400).json({ ok: false, error: 'No valid items to submit.' });
    }

    const stockResult = await deductStockForLines(supabaseAdmin, restaurant.id, stockLines);
    if (!stockResult.ok) {
      const s = stockResult.shortages[0];
      return res.status(409).json({
        ok: false,
        error: `Only ${s.available} left of ${s.name} (you asked for ${s.asked}).`,
        shortages: stockResult.shortages,
      });
    }

    const subtotal = normalizedItems.reduce((sum, line) => sum + Number(line.line_total || 0), 0);
    const sessionMeta = session?.meta || {};
    const rawType = String(session?.type || sessionMeta.service_type || 'takeaway').toLowerCase();
    const orderMode = String(
      sessionMeta.order_mode
      || (rawType.startsWith('scheduled_') ? 'scheduled' : '')
      || ''
    ).toLowerCase();
    let serviceType = rawType;
    if (shippedOrder) {
      serviceType = 'delivery';
    } else if (rawType === 'scheduled_delivery') serviceType = 'delivery';
    else if (rawType === 'scheduled_takeaway' || rawType === 'scheduled_pickup') serviceType = 'takeaway';
    else if (rawType === 'dinein' || rawType === 'dine-in') serviceType = 'dine_in';
    else if (sessionMeta.service_type) serviceType = String(sessionMeta.service_type).toLowerCase();
    const parcelPerItem = parseFloat(restaurant.parcel_charge_per_item || 0);
    const gstRate = parseFloat(restaurant.gst_rate || 5.0);

// Parcel charge: sum of qty × rate per item (only for takeaway/delivery)
    let parcelCharge = 0;
    if (['takeaway', 'delivery'].includes(serviceType) && parcelPerItem > 0) {
      parcelCharge = normalizedItems.reduce((s, l) => s + l.qty * parcelPerItem, 0);
      parcelCharge = Math.round(parcelCharge * 100) / 100;
    }

// Delivery charge — shipped LOBs always re-quote server-side; restaurants use flat default
    let deliveryCharge = 0;
    let deliveryQuote = null;
    if (shippedOrder) {
      deliveryQuote = await calculateDelivery(restaurant, safePincode, subtotal, {
        items: normalizedItems,
      });
      deliveryCharge = Number(deliveryQuote.charge || 0);
    } else if (serviceType === 'delivery') {
      deliveryCharge = parseFloat(restaurant.delivery_charge_default || 40);
    }

    const preGst = Math.round((subtotal + parcelCharge + deliveryCharge) * 100) / 100;
    const gstAmount = Math.round(preGst * gstRate / 100 * 100) / 100;
    const totalAmount = Math.round((preGst + gstAmount) * 100) / 100;

    if (totalAmount < 1) {
      return res.status(400).json({ ok: false, error: 'Total amount is too low to process payment.' });
    }

    const orderRef = `${(session?.id || safeToken)}-${Date.now().toString().slice(-6)}`;
    const formattedAddress = shippedOrder
      ? formatDeliveryAddress(safeAddress, safePincode)
      : '';
    const submissionFingerprint = buildSubmissionFingerprint({
      items: normalizedItems,
      promo_code,
      special_request,
      total: totalAmount,
      delivery_address: formattedAddress,
      pincode: safePincode,
    });

    const prevSubmission = session?.meta?.web_cart_submission || {};
    const prevSubmittedAt = prevSubmission?.submitted_at ? new Date(prevSubmission.submitted_at).getTime() : 0;
    const prevIsFresh = Number.isFinite(prevSubmittedAt) && (Date.now() - prevSubmittedAt) < (20 * 60 * 1000);
    const isSameSubmission =
      prevSubmission?.submission_fingerprint &&
      prevSubmission.submission_fingerprint === submissionFingerprint;
    const alreadySent = !!prevSubmission?.payment_cta_sent;

    if (prevIsFresh && isSameSubmission && alreadySent) {
      return res.json({
        ok: true,
        order_ref: prevSubmission.order_ref || orderRef,
        message: 'Confirm & Pay was already sent to your WhatsApp. Please complete payment there.',
        deduped: true,
      });
    }

    const nextMeta = {
      ...sessionMeta,
      service_type: serviceType,
      order_mode: orderMode || sessionMeta.order_mode || null,
      scheduled_at: sessionMeta.scheduled_at || null,
      customer_name: shippedOrder ? safeName : (sessionMeta.customer_name || sessionMeta.name || null),
      delivery_address: shippedOrder ? formattedAddress : (sessionMeta.delivery_address || null),
      delivery_pincode: shippedOrder ? safePincode : (sessionMeta.delivery_pincode || null),
      delivery_zone: deliveryQuote?.zone || sessionMeta.delivery_zone || null,
      delivery_source: deliveryQuote?.source || sessionMeta.delivery_source || null,
      web_cart_submission: {
        submitted_at: new Date().toISOString(),
        promo_code: promo_code ? String(promo_code).trim().slice(0, 40) : null,
        special_request: special_request ? String(special_request).trim().slice(0, 500) : null,
        customer_name: shippedOrder ? safeName : null,
        delivery_address: shippedOrder ? formattedAddress : null,
        delivery_pincode: shippedOrder ? safePincode : null,
        delivery_zone: deliveryQuote?.zone || null,
        delivery_source: deliveryQuote?.source || null,
        free_delivery_applied: !!deliveryQuote?.free_delivery_applied,
        cod_enabled: deliveryQuote?.cod_enabled ?? null,
        item_count: normalizedItems.length,
        items: normalizedItems,
        parcel_charge: parcelCharge,
        delivery_charge: deliveryCharge,
        gst_rate: gstRate,
        gst_amount: gstAmount,
        pre_gst_total: preGst,
        total: totalAmount,
        order_ref: orderRef,
        submission_fingerprint: submissionFingerprint,
        payment_cta_sent: false,
      },
    };

    if (session) {
      const { error } = await supabaseAdmin
        .from('walk_in_tokens')
        .update({ meta: nextMeta })
        .eq('restaurant_id', restaurant.id)
        .eq('id', session.id)
        .eq('phone', session.phone);

      if (error) throw error;
    }

    const confirmResult = await triggerConfirmAndPay({
      restaurant_id: restaurant.id,
      customer_phone: session?.phone || safePhone,
      customer_name: shippedOrder
        ? safeName
        : (String(sessionMeta?.customer_name || sessionMeta?.name || '').trim() || 'Guest'),
      delivery_address: shippedOrder ? formattedAddress : undefined,
      pincode: shippedOrder ? safePincode : undefined,
      token: String(session?.id || safeToken),
      order_ref: orderRef,
      // Send the walk-in type when scheduled so chat can gate approval;
      // otherwise send normalized booking service_type.
      service_type: orderMode === 'scheduled' || rawType.startsWith('scheduled_')
        ? rawType
        : serviceType,
      order_mode: orderMode || undefined,
      scheduled_at: sessionMeta.scheduled_at || undefined,
      total: totalAmount,
      items: normalizedItems,
      promo_code: promo_code ? String(promo_code).trim().slice(0, 40) : null,
      special_request: special_request ? String(special_request).trim().slice(0, 500) : null,
      delivery_charge: deliveryCharge,
      delivery_zone: deliveryQuote?.zone || undefined,
      delivery_source: deliveryQuote?.source || undefined,
    });

    if (session) {
      const confirmedMeta = {
        ...(nextMeta || {}),
        web_cart_submission: {
          ...(nextMeta.web_cart_submission || {}),
          payment_cta_sent: true,
          booking_id: confirmResult?.booking_id || null,
          payment_link: confirmResult?.payment_link || null,
        },
      };

      await supabaseAdmin
        .from('walk_in_tokens')
        .update({ meta: confirmedMeta })
        .eq('restaurant_id', restaurant.id)
        .eq('id', session.id)
        .eq('phone', session.phone);
    }

    let giftUrl = null;
    if (req.body?.is_gift) {
      try {
        const { createGiftLink } = require('../helpers/giftLinks');
        const gift = await createGiftLink(supabaseAdmin, {
          restaurantId: restaurant.id,
          bookingId: confirmResult?.booking_id || null,
          gifterPhone: session?.phone || safePhone,
          recipientPhone: req.body?.gift_recipient_phone || null,
          recipientName: req.body?.gift_recipient_name || null,
          giftMessage: req.body?.gift_message || null,
          // The order actually ships to whatever address/pincode was submitted
          // for delivery — recorded here so gift orders stay traceable even
          // though the gifter (not the recipient) is the paying customer.
          recipientAddress: shippedOrder ? formattedAddress : null,
          recipientPincode: shippedOrder ? safePincode : null,
        });
        giftUrl = `${req.protocol}://${req.get('host')}/gift/${gift.token}`;
      } catch (giftErr) {
        console.warn('[webcart/submit] gift link:', giftErr.message);
      }
    }

    return res.json({
      ok: true,
      order_ref: orderRef,
      booking_id: confirmResult?.booking_id || null,
      payment_link: confirmResult?.payment_link || null,
      gift_url: giftUrl,
      awaiting_approval: !!confirmResult?.awaiting_approval,
      message: confirmResult?.awaiting_approval
        ? 'Order submitted for manager approval. Check WhatsApp for updates.'
        : confirmResult?.payment_link
          ? 'Hosted checkout ready.'
          : 'Confirm & Pay has been sent to your WhatsApp.',
    });
  } catch (err) {
    console.error('[webcart/submit]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to submit order.' });
  }
});

router.get('/api/webcart/saved-addresses', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    const phone = String(req.query.phone || '').trim();
    if (!token || !phone) {
      return res.status(400).json({ ok: false, error: 'token and phone are required.' });
    }

    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found.' });

    await resolveSession({
      restaurantId: restaurant.id,
      token,
      phone,
    });

    const variants = phoneVariants(phone);
    if (!variants.length) {
      return res.json({ ok: true, addresses: [] });
    }

    const { data: customers, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id')
      .eq('restaurant_id', restaurant.id)
      .in('phone', variants);
    if (custErr) throw custErr;

    const customerIds = (customers || []).map((row) => row.id).filter(Boolean);
    if (!customerIds.length) {
      return res.json({ ok: true, addresses: [] });
    }

    const { data: bookings, error: bookErr } = await supabaseAdmin
      .from('bookings')
      .select('delivery_address, created_at')
      .eq('restaurant_id', restaurant.id)
      .in('customer_id', customerIds)
      .not('delivery_address', 'is', null)
      .order('created_at', { ascending: false })
      .limit(40);
    if (bookErr) throw bookErr;

    const seen = new Set();
    const addresses = [];
    for (const row of (bookings || [])) {
      const raw = String(row.delivery_address || '').trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const pin = parsePincodeFromAddress(raw);
      let address = raw;
      if (pin) {
        address = raw.replace(new RegExp(`[,\\s]*${pin}\\s*$`), '').trim() || raw;
      }
      addresses.push({ address, pincode: pin || '' });
      if (addresses.length >= 5) break;
    }

    return res.json({ ok: true, addresses });
  } catch (err) {
    console.error('[webcart/saved-addresses]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load saved addresses.' });
  }
});

router.post('/api/webcart/delivery-quote', async (req, res) => {
  try {
    const { pincode, cart_total, items } = req.body || {};
    const customerPincode = normalizePincode(pincode);
    if (!customerPincode) {
      return res.status(400).json({ ok: false, error: 'A valid 6-digit pincode is required.' });
    }

    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found.' });

    // Resolve catalog weights server-side (client qty × menu weight_grams)
    let weighedItems = [];
    const rawItems = Array.isArray(items) ? items : [];
    if (rawItems.length) {
      const { data: liveItems, error: liveErr } = await supabaseAdmin
        .from('menu_items')
        .select('id, retailer_id, weight_grams, item_type, meta')
        .eq('restaurant_id', restaurant.id)
        .is('archived_at', null);
      if (liveErr) throw liveErr;
      weighedItems = resolveCartLineWeights(rawItems, liveItems || []);
    }

    const quote = await calculateDelivery(restaurant, customerPincode, cart_total, {
      items: weighedItems,
    });
    return res.json({ ok: true, ...quote });
  } catch (err) {
    console.error('[webcart/delivery-quote]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to calculate delivery charge.' });
  }
});

const SHIPROCKET_STATUS_MAP = {
  pickup_scheduled: 'Pickup scheduled',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
};

/** Notify-me waitlist when a SKU is sold out. */
router.post('/api/webcart/stock-waitlist', async (req, res) => {
  try {
    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found.' });

    const phone = String(req.body?.phone || req.query.phone || '').trim();
    const retailerId = String(req.body?.retailer_id || '').trim() || null;
    const menuItemId = String(req.body?.menu_item_id || '').trim() || null;
    let itemName = String(req.body?.item_name || '').trim() || null;
    const reason = String(req.body?.reason || 'restock').toLowerCase() === 'launch' ? 'launch' : 'restock';

    if (!phone) return res.status(400).json({ ok: false, error: 'phone is required.' });
    if (!retailerId && !menuItemId) {
      return res.status(400).json({ ok: false, error: 'retailer_id or menu_item_id is required.' });
    }

    if (!itemName && (menuItemId || retailerId)) {
      let q = supabaseAdmin
        .from('menu_items')
        .select('id, name, retailer_id')
        .eq('restaurant_id', restaurant.id)
        .limit(1);
      if (menuItemId) q = q.eq('id', menuItemId);
      else q = q.eq('retailer_id', retailerId);
      const { data: row } = await q.maybeSingle();
      if (row) {
        itemName = row.name;
      }
    }

    const row = await joinStockWaitlist(supabaseAdmin, {
      restaurantId: restaurant.id,
      phone,
      menuItemId,
      retailerId: retailerId || menuItemId,
      itemName,
      reason,
    });

    const msg = reason === 'launch'
      ? `You're on the launch list for ${itemName || 'this item'}. We'll WhatsApp you when it drops.`
      : `We'll WhatsApp you when ${itemName || 'this item'} is back in stock.`;

    return res.json({
      ok: true,
      id: row?.id || null,
      message: msg,
    });
  } catch (err) {
    console.error('[webcart/stock-waitlist]', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'Could not join waitlist.' });
  }
});

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

router.post('/api/webhooks/shiprocket', async (req, res) => {
  try {
    const body = req.body || {};
    const awb = String(body.awb || body.awb_code || '').trim();
    const orderId = String(body.order_id || body.shipment_id || body.channel_order_id || '').trim();
    const statusRaw = String(body.current_status || body.status || '').toLowerCase().replace(/\s+/g, '_');
    const statusLabel = SHIPROCKET_STATUS_MAP[statusRaw] || body.current_status || body.status || 'Updated';

    if (!awb && !orderId) {
      return res.status(400).json({ ok: false, error: 'Missing shipment identifier.' });
    }

    let booking = null;
    if (orderId) {
      const { data: byRef, error: refErr } = await supabaseAdmin
        .from('bookings')
        .select('id, restaurant_id, customer_phone, order_ref, meta')
        .eq('order_ref', orderId)
        .maybeSingle();
      if (refErr) throw refErr;
      booking = byRef;
      if (!booking) {
        const { data: byMeta, error: metaErr } = await supabaseAdmin
          .from('bookings')
          .select('id, restaurant_id, customer_phone, order_ref, meta')
          .filter('meta->>shiprocket_order_id', 'eq', orderId)
          .maybeSingle();
        if (metaErr) throw metaErr;
        booking = byMeta;
      }
    } else {
      const { data: byAwb, error: awbErr } = await supabaseAdmin
        .from('bookings')
        .select('id, restaurant_id, customer_phone, order_ref, meta')
        .filter('meta->>awb', 'eq', awb)
        .maybeSingle();
      if (awbErr) throw awbErr;
      booking = byAwb;
    }
    if (!booking) {
      return res.json({ ok: true, skipped: true, reason: 'booking_not_found' });
    }

    const nextMeta = {
      ...(booking.meta || {}),
      shipment_status: statusRaw,
      awb: awb || booking.meta?.awb || null,
      courier_name: body.courier_name || body.courier || booking.meta?.courier_name || 'Shiprocket',
    };
    await supabaseAdmin.from('bookings').update({ meta: nextMeta }).eq('id', booking.id);

    await triggerShipmentNotify({
      restaurant_id: booking.restaurant_id,
      customer_phone: booking.customer_phone,
      order_ref: booking.order_ref || booking.id,
      courier_name: nextMeta.courier_name,
      awb: nextMeta.awb,
      status: statusLabel,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[webhooks/shiprocket]', err.message);
    return res.status(500).json({ ok: false, error: 'Webhook processing failed.' });
  }
});

router.get(['/cart', '/menu', '/shop'], (_req, res) => {
  // Webcart behavior changes frequently during debugging and deployment.
  // Disable browser reuse so refreshed pages always pick up the latest UI logic.
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'public', 'webcart.html'));
});

router.get('/gift/:token', async (req, res) => {
  try {
    const { getGiftByToken, redeemGiftLink } = require('../helpers/giftLinks');
    const gift = await getGiftByToken(supabaseAdmin, req.params.token);
    if (!gift) {
      return res.status(404).type('html').send('<h1>Gift link not found</h1>');
    }
    const { data: restaurant } = await supabaseAdmin
      .from('tenants')
      .select('id, display_name, name')
      .eq('id', gift.restaurant_id)
      .maybeSingle();
    const brand = restaurant?.display_name || restaurant?.name || 'Kitchen';
    if (String(req.query.redeem || '') === '1') {
      await redeemGiftLink(supabaseAdmin, gift.token, {
        recipientPhone: req.query.phone || null,
      });
    }
    const note = gift.gift_message
      ? `<p style="font-size:16px;color:#444">“${String(gift.gift_message).replace(/</g, '')}”</p>`
      : '';
    res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Gift · ${brand}</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#1a1a1a}
h1{font-size:22px} .btn{display:inline-block;margin-top:16px;background:#128c7e;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none}</style></head>
<body>
  <h1>A gift from ${brand}</h1>
  ${note}
  <p>Status: <strong>${gift.status}</strong></p>
  <a class="btn" href="/shop?slug=${encodeURIComponent(String(brand).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'shop')}">Browse the shop</a>
</body></html>`);
  } catch (err) {
    console.error('[gift]', err.message);
    res.status(500).type('html').send('<h1>Could not open gift</h1>');
  }
});

router.get('/feedback', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'public', 'feedback.html'));
});

module.exports = router;
