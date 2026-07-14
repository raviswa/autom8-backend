'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');

const { supabaseAdmin } = require('../config/supabase');
const { getKdsSecret } = require('../config/internalSecret');

const ACTIVE_TOKEN_STATUSES = new Set(['waiting', 'pending_approval', 'seated', 'takeaway']);
const DEFAULT_THEME = {
  primary_color: '#C2410C',
  accent_color: '#111827',
};
const CHAT_SERVICE_URL = (process.env.CHAT_SERVICE_URL || 'http://localhost:8001').replace(/\/$/, '');

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

function buildSubmissionFingerprint({ items, promo_code, special_request, total }) {
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
      .select('id, name, display_name, logo_url, contact_phone, manager_phone, whatsapp_number, timezone, opening_hours, primary_slot_category, parcel_charge_per_item, delivery_charge_default, delivery_charge_tiers, gst_rate, kitchen_busy, lob_type, postal_code, shiprocket_connected, shiprocket_api_key, intra_city_charge, outstation_charge, free_delivery_above, cod_enabled_city, cod_enabled_outstation')
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

function normalizePincode(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 6 ? digits.slice(0, 6) : '';
}

function isSameCityPincode(tenantPincode, customerPincode) {
  const tenant = normalizePincode(tenantPincode);
  const customer = normalizePincode(customerPincode);
  if (!tenant || !customer) return false;
  if (tenant === customer) return true;
  // India pincode: first 3 digits identify the sorting district / city area.
  return tenant.slice(0, 3) === customer.slice(0, 3);
}

async function fetchShiprocketRate({ apiKey, pickupPincode, deliveryPincode, weightKg = 0.5 }) {
  if (!apiKey || !pickupPincode || !deliveryPincode) return null;
  try {
    const url = new URL('https://apiv2.shiprocket.in/v1/external/courier/serviceability/');
    url.searchParams.set('pickup_postcode', pickupPincode);
    url.searchParams.set('delivery_postcode', deliveryPincode);
    url.searchParams.set('weight', String(weightKg));
    url.searchParams.set('cod', '0');

    const rateRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await rateRes.json().catch(() => ({}));
    if (!rateRes.ok) {
      console.warn('[webcart/shiprocket]', data?.message || rateRes.status);
      return null;
    }
    const couriers = data?.data?.available_courier_companies || data?.data || [];
    const list = Array.isArray(couriers) ? couriers : [];
    if (!list.length) return null;
    const cheapest = list.reduce((min, row) => {
      const charge = Number(row.rate || row.freight_charge || row.charge || 0);
      return charge > 0 && charge < min ? charge : min;
    }, Number.POSITIVE_INFINITY);
    return Number.isFinite(cheapest) && cheapest < Number.POSITIVE_INFINITY ? cheapest : null;
  } catch (err) {
    console.warn('[webcart/shiprocket]', err.message);
    return null;
  }
}

async function calculateDelivery(restaurant, customerPincode, cartTotal) {
  const tenantPincode = normalizePincode(restaurant?.postal_code);
  const customer = normalizePincode(customerPincode);
  const subtotal = Math.max(0, Number(cartTotal || 0));
  const freeAbove = Number(restaurant?.free_delivery_above || 0);
  const intraCity = isSameCityPincode(tenantPincode, customer);
  const zone = intraCity ? 'intra_city' : 'outstation';

  if (freeAbove > 0 && subtotal >= freeAbove) {
    return {
      zone,
      charge: 0,
      free_delivery_applied: true,
      cod_enabled: intraCity ? !!restaurant?.cod_enabled_city : !!restaurant?.cod_enabled_outstation,
      source: 'free_delivery_above',
    };
  }

  if (intraCity) {
    const charge = Number(restaurant?.intra_city_charge ?? restaurant?.delivery_charge_default ?? 0) || 0;
    return {
      zone,
      charge: Math.round(charge * 100) / 100,
      free_delivery_applied: false,
      cod_enabled: !!restaurant?.cod_enabled_city,
      source: 'intra_city_flat',
    };
  }

  let charge = Number(restaurant?.outstation_charge || 0) || 0;
  let source = 'outstation_flat';
  if (restaurant?.shiprocket_connected && restaurant?.shiprocket_api_key && tenantPincode && customer) {
    const shiprocketRate = await fetchShiprocketRate({
      apiKey: restaurant.shiprocket_api_key,
      pickupPincode: tenantPincode,
      deliveryPincode: customer,
    });
    if (shiprocketRate != null) {
      charge = shiprocketRate;
      source = 'shiprocket';
    }
  }

  return {
    zone,
    charge: Math.round(charge * 100) / 100,
    free_delivery_applied: false,
    cod_enabled: !!restaurant?.cod_enabled_outstation,
    source,
  };
}

function resolveCurrentSlot(restaurant) {
  const opening = restaurant?.opening_hours || {};
  const { hour, total } = minutesInTimezone(restaurant?.timezone || 'Asia/Kolkata');
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
  return clean.length ? clean : ['anytime'];
}

async function resolveSession({ restaurantId, token, phone }) {
  const rawVariants = phoneVariants(phone);
  if (!restaurantId || !token) return null;

  let menuToken = null;
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
    } else {
      menuToken = menuData || null;
    }
  } catch (err) {
    throw err;
  }

  const tokenPhone = menuToken?.phone || '';
  const variants = rawVariants.length ? rawVariants : phoneVariants(tokenPhone);
  if (!variants.length) return null;

  const walkTokenId = menuToken?.walk_in_token_id || token;

  let data = null;
  if (walkTokenId) {
    const { data: byId, error } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('id, phone, status, arrived_at, completed_at, meta, type')
      .eq('restaurant_id', restaurantId)
      .eq('id', walkTokenId)
      .in('phone', variants)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    data = byId || null;
  }

  if (!data && menuToken) {
    const { data: byPhone, error } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('id, phone, status, arrived_at, completed_at, meta, type')
      .eq('restaurant_id', restaurantId)
      .in('phone', variants)
      .order('arrived_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    data = byPhone || null;

    if (data?.id && !menuToken.walk_in_token_id) {
      await supabaseAdmin
        .from('menu_tokens')
        .update({ walk_in_token_id: data.id })
        .eq('restaurant_id', restaurantId)
        .eq('session_token', token)
        .eq('is_active', true)
        .in('phone', variants);
    }
  }

  if (!data) return null;

  if (!ACTIVE_TOKEN_STATUSES.has(data.status) || data.completed_at) return null;

  const arrivedAt = data.arrived_at ? new Date(data.arrived_at) : null;
  const ageMs = arrivedAt ? Date.now() - arrivedAt.getTime() : Number.POSITIVE_INFINITY;
  if (!arrivedAt || ageMs > 1000 * 60 * 60 * 12) return null;

  return data;
}

async function fetchMenuItems(restaurantId) {
  const cached = _menuCache.get(restaurantId);
  const now = Date.now();
  if (cached && (now - cached.fetchedAt) <= MENU_CACHE_TTL_MS) {
    return { items: cached.items, categorySlotMap: cached.categorySlotMap };
  }

  const [itemsRes, categoriesRes] = await Promise.all([
    supabaseAdmin
      .from('menu_items')
      .select('id, retailer_id, name, price, category, description, image_url, image_url_2, image_url_3, image_url_4, image_url_5, is_special_today, is_todays_special, special_note, applicable_slots, is_stocked, is_available, variant_group_id, size_label, item_type, flavour_group, scoop_count, crust_options, toppings_allowed, topping_extra_price, pack_size_label, weight_grams, shelf_life_days, allergens, condition, original_mrp, warranty_days, colour')
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
  if (categoriesRes.error) throw categoriesRes.error;

  const categorySlotMap = Object.fromEntries(
    (categoriesRes.data || []).map(row => [row.name, normalizeSlots(row.applicable_slots)])
  );

  const items = (itemsRes.data || []).map(item => ({
    ...item,
    is_available: !!item.is_available,
    is_stocked: !!item.is_stocked,
    is_publicly_available: !!(item.is_available && item.is_stocked),
    effective_slots: normalizeSlots(item.applicable_slots || categorySlotMap[item.category] || ['anytime']),
    is_todays_special: !!(item.is_todays_special || item.is_special_today),
  }));

  _menuCache.set(restaurantId, { items, categorySlotMap, fetchedAt: now });

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

    if (!token || !phone) {
      return res.status(400).json({
        valid: false,
        code: 'BAD_REQUEST',
        message: 'token and phone are required.',
      });
    }

    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) {
      return res.status(404).json({
        valid: false,
        code: 'RESTAURANT_NOT_FOUND',
        message: 'Restaurant not found.',
      });
    }

    const session = await resolveSession({
      restaurantId: restaurant.id,
      token,
      phone,
    });

    const { items: menuItems, categorySlotMap } = await fetchMenuItems(restaurant.id);
    const lobType = restaurant.lob_type || 'restaurant';
    const catalogLob = !isRestaurantLob(lobType);

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

    const sessionPayload = session
      ? {
          token: session.id,
          phone: session.phone,
          type: session.type,
        }
      : {
          token,
          phone,
          type: 'takeaway',
        };

    const orderingEnabled = true;

    return res.json({
      valid: true,
      ordering_enabled: orderingEnabled,
      session_expired: !session,
      restaurant: {
        id: restaurant.id,
        name: restaurant.display_name || restaurant.name,
        logo_url: restaurant.logo_url || null,
        support_phone: pickSupportPhone(restaurant) || null,
        lob_type: lobType,
      },
      pricing_config: {                                         // ← ADD THIS BLOCK
        parcel_charge_per_item: restaurant.parcel_charge_per_item || 0,
        gst_rate: restaurant.gst_rate || 5,
        delivery_charge_default: restaurant.delivery_charge_default || 40,
      },
      
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
      // Informational only — the manager's "busy kitchen" rush-hour flag
      // (POST /api/catalog/kitchen-busy-toggle) intentionally does not block
      // ordering here; it's surfaced for future conversational-flow use
      // (e.g. showing a longer prep-time notice), not as a booking gate.
      kitchen_busy: !!restaurant.kitchen_busy,
      // preferred_category = manager primary for the active meal slot (chip sort hint).
      // Webcart always opens on "All Items" — do not force another tab.
      preferred_category: preferredCategory,
      category_slots: categorySlotMap,
      promotions: [],
      session_message: session
        ? null
        : 'Your WhatsApp session expired, but the menu is still available to browse. Please request a fresh link to submit an order.',
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
    const { token, phone, items, special_request, promo_code } = req.body || {};
    const safeToken = String(token || '').trim();
    const safePhone = String(phone || '').trim();

    if (!safeToken || !safePhone || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ ok: false, error: 'token, phone, and at least one item are required.' });
    }

    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found.' });

    const session = await resolveSession({
      restaurantId: restaurant.id,
      token: safeToken,
      phone: safePhone,
    });

    const { data: liveItems, error: liveErr } = await supabaseAdmin
      .from('menu_items')
      .select('id, retailer_id, name, price')
      .eq('restaurant_id', restaurant.id)
      .eq('is_stocked', true)
      .is('archived_at', null);

    if (liveErr) throw liveErr;

    const liveMap = new Map();
    for (const row of (liveItems || [])) {
      liveMap.set(String(row.id), row);
      if (row.retailer_id) liveMap.set(String(row.retailer_id), row);
    }

    const liveKey = new Set(liveMap.keys());
    const unavailable = items
      .filter(i => !liveKey.has(String(i.id || '')))
      .map(i => i.name)
      .filter(Boolean);

    if (unavailable.length) {
      const label = unavailable.slice(0, 3).join(', ');
      return res.status(409).json({
        ok: false,
        error: `${label} ${unavailable.length > 1 ? 'are' : 'is'} no longer available — please remove ${unavailable.length > 1 ? 'them' : 'it'} to continue.`,
        unavailable_items: unavailable,
      });
    }

    const normalizedItems = [];
    for (const row of items) {
      const source = liveMap.get(String(row.id || ''));
      if (!source) continue;

      const qty = Math.max(0, Math.floor(Number(row.qty || 0)));
      if (!qty) continue;

      const unitPrice = Number(source.price || 0);
      normalizedItems.push({
        id: source.retailer_id || source.id,
        name: source.name,
        qty,
        price: unitPrice,
        line_total: unitPrice * qty,
      });
    }

    if (!normalizedItems.length) {
      return res.status(400).json({ ok: false, error: 'No valid items to submit.' });
    }

    const subtotal = normalizedItems.reduce((sum, line) => sum + Number(line.line_total || 0), 0);
    const serviceType = String(session?.type || 'takeaway').toLowerCase();
    const parcelPerItem = parseFloat(restaurant.parcel_charge_per_item || 0);
    const gstRate = parseFloat(restaurant.gst_rate || 5.0);

// Parcel charge: sum of qty × rate per item (only for takeaway/delivery)
    let parcelCharge = 0;
    if (['takeaway', 'delivery'].includes(serviceType) && parcelPerItem > 0) {
      parcelCharge = normalizedItems.reduce((s, l) => s + l.qty * parcelPerItem, 0);
      parcelCharge = Math.round(parcelCharge * 100) / 100;
    }

// Delivery charge (only for delivery)
    let deliveryCharge = 0;
    if (serviceType === 'delivery') {
      deliveryCharge = parseFloat(restaurant.delivery_charge_default || 40);
    }

    const preGst = Math.round((subtotal + parcelCharge + deliveryCharge) * 100) / 100;
    const gstAmount = Math.round(preGst * gstRate / 100 * 100) / 100;
    const totalAmount = Math.round((preGst + gstAmount) * 100) / 100;

    if (totalAmount < 1) {
      return res.status(400).json({ ok: false, error: 'Total amount is too low to process payment.' });
    }

    const orderRef = `${(session?.id || safeToken)}-${Date.now().toString().slice(-6)}`;
    const submissionFingerprint = buildSubmissionFingerprint({
      items: normalizedItems,
      promo_code,
      special_request,
      total: totalAmount,
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

    const sessionMeta = session?.meta || {};
    const nextMeta = {
      ...sessionMeta,
      web_cart_submission: {
        submitted_at: new Date().toISOString(),
        promo_code: promo_code ? String(promo_code).trim().slice(0, 40) : null,
        special_request: special_request ? String(special_request).trim().slice(0, 500) : null,
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
      customer_name:
        String(sessionMeta?.customer_name || sessionMeta?.name || '').trim() ||
        'Guest',
      token: String(session?.id || safeToken),
      order_ref: orderRef,
      service_type: String(session?.type || 'takeaway'),
      total: totalAmount,
      items: normalizedItems,
      promo_code: promo_code ? String(promo_code).trim().slice(0, 40) : null,
      special_request: special_request ? String(special_request).trim().slice(0, 500) : null,
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

    return res.json({
      ok: true,
      order_ref: orderRef,
      booking_id: confirmResult?.booking_id || null,
      payment_link: confirmResult?.payment_link || null,
      message: confirmResult?.payment_link
        ? 'Hosted checkout ready.'
        : 'Confirm & Pay has been sent to your WhatsApp.',
    });
  } catch (err) {
    console.error('[webcart/submit]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to submit order.' });
  }
});

router.post('/api/webcart/delivery-quote', async (req, res) => {
  try {
    const { pincode, cart_total } = req.body || {};
    const customerPincode = normalizePincode(pincode);
    if (!customerPincode) {
      return res.status(400).json({ ok: false, error: 'A valid 6-digit pincode is required.' });
    }

    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found.' });

    const quote = await calculateDelivery(restaurant, customerPincode, cart_total);
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

router.get(['/cart', '/menu'], (_req, res) => {
  // Webcart behavior changes frequently during debugging and deployment.
  // Disable browser reuse so refreshed pages always pick up the latest UI logic.
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'public', 'webcart.html'));
});

router.get('/feedback', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'public', 'feedback.html'));
});

module.exports = router;
