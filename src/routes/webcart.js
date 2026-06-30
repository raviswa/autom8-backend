'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');

const { supabaseAdmin } = require('../config/supabase');

const ACTIVE_TOKEN_STATUSES = new Set(['waiting', 'pending_approval', 'seated', 'takeaway']);
const DEFAULT_THEME = {
  primary_color: '#C2410C',
  accent_color: '#111827',
};

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
    restaurant?.contact_phone || restaurant?.manager_phone || restaurant?.whatsapp_number || ''
  );
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
    support_phone: supportPhone || null,
  };
}

async function resolveRestaurantBySlug(req) {
  const slug = (req.query.slug || readHostSlug(req) || '').toString().trim().toLowerCase();

  const { data, error } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, display_name, logo_url, contact_phone, manager_phone, whatsapp_number, timezone, opening_hours, primary_slot_category')
    .eq('is_active', true)
    .limit(500);

  if (error) throw error;
  const rows = data || [];

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
  const variants = phoneVariants(phone);
  if (!restaurantId || !token || !variants.length) return null;

  let menuToken = null;
  try {
    const { data: menuData, error: menuErr } = await supabaseAdmin
      .from('menu_tokens')
      .select('session_token, phone, walk_in_token_id, expires_at, is_active')
      .eq('restaurant_id', restaurantId)
      .eq('session_token', token)
      .in('phone', variants)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .limit(1)
      .maybeSingle();

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
  const [itemsRes, categoriesRes] = await Promise.all([
    supabaseAdmin
      .from('menu_items')
      .select('id, retailer_id, name, price, category, description, image_url, is_special_today, is_todays_special, special_note, applicable_slots, is_stocked')
      .eq('restaurant_id', restaurantId)
      .eq('is_stocked', true)
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
    effective_slots: normalizeSlots(item.applicable_slots || categorySlotMap[item.category] || ['anytime']),
    is_todays_special: !!(item.is_todays_special || item.is_special_today),
  }));

  return { items, categorySlotMap };
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

    if (!session) {
      return res.status(410).json(buildExpiredPayload(restaurant));
    }

    const { items: menuItems, categorySlotMap } = await fetchMenuItems(restaurant.id);
    const slotInfo = resolveCurrentSlot(restaurant);
    const availableNow = slotInfo.current_slot
      ? menuItems.filter(i => i.effective_slots.includes('anytime') || i.effective_slots.includes(slotInfo.current_slot))
      : [];
    const todaysSpecial = menuItems.filter(i => i.is_todays_special);

    const countsByCategory = {};
    if (slotInfo.current_slot) {
      for (const item of availableNow) {
        const cat = item.category || 'General';
        countsByCategory[cat] = (countsByCategory[cat] || 0) + 1;
      }
    }
    let primaryCategory = null;
    const primarySlotMap = restaurant?.primary_slot_category || {};
    const preferredForSlot = slotInfo.current_slot
      ? String(primarySlotMap?.[slotInfo.current_slot] || '').trim()
      : '';
    const top = Object.entries(countsByCategory)
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        if (preferredForSlot && a[0] === preferredForSlot) return -1;
        if (preferredForSlot && b[0] === preferredForSlot) return 1;
        return a[0].localeCompare(b[0]);
      })[0];
    if (top) primaryCategory = top[0];

    return res.json({
      valid: true,
      restaurant: {
        id: restaurant.id,
        name: restaurant.display_name || restaurant.name,
        logo_url: restaurant.logo_url || null,
        support_phone: pickSupportPhone(restaurant) || null,
      },
      theme: DEFAULT_THEME,
      session: {
        token: session.id,
        phone: session.phone,
        type: session.type,
      },
      menu_items: menuItems,
      todays_special: todaysSpecial,
      available_now: availableNow,
      current_slot: slotInfo.current_slot,
      slot_state: slotInfo.slot_state,
      slot_banner: slotInfo.banner || null,
      primary_category: primaryCategory,
      category_slots: categorySlotMap,
      promotions: [],
    });
  } catch (err) {
    console.error('[webcart/session]', err.message);
    return res.status(500).json({ valid: false, code: 'SERVER_ERROR', message: 'Failed to load cart session.' });
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

    if (!session) {
      return res.status(410).json(buildExpiredPayload(restaurant));
    }

    const { data: liveItems, error: liveErr } = await supabaseAdmin
      .from('menu_items')
      .select('id, retailer_id, name')
      .eq('restaurant_id', restaurant.id)
      .eq('is_stocked', true);

    if (liveErr) throw liveErr;

    const liveKey = new Set((liveItems || []).flatMap(row => [String(row.id), String(row.retailer_id || '')]));
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

    const nextMeta = {
      ...(session.meta || {}),
      web_cart_submission: {
        submitted_at: new Date().toISOString(),
        promo_code: promo_code ? String(promo_code).trim().slice(0, 40) : null,
        special_request: special_request ? String(special_request).trim().slice(0, 500) : null,
        item_count: items.length,
        items,
      },
    };

    const { error } = await supabaseAdmin
      .from('walk_in_tokens')
      .update({ meta: nextMeta })
      .eq('restaurant_id', restaurant.id)
      .eq('id', session.id)
      .eq('phone', session.phone);

    if (error) throw error;

    return res.json({
      ok: true,
      order_ref: `${session.id}-${Date.now().toString().slice(-6)}`,
      message: 'Order submitted successfully.',
    });
  } catch (err) {
    console.error('[webcart/submit]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to submit order.' });
  }
});

router.get(['/cart', '/menu'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'webcart.html'));
});

module.exports = router;
