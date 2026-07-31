'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin } = require('../../config/supabase');
const { authenticateToken, getRestaurantId } = require('../../middleware/auth');
const { getKdsSecret } = require('../../config/internalSecret');
const {
  exportCategoryLabel,
  exportTimeSlotLabel,
} = require('./shared/uploadParse');

router.get('/feed', async (req, res) => {
  try {
    const restaurantId = req.query.restaurant_id || process.env.DEFAULT_RESTAURANT_ID;
    const { data: rawItems, error } = await supabaseAdmin
      .from('menu_items')
      .select('retailer_id, name, description, price, image_url, time_slot, is_stocked, is_available, category')
      .eq('restaurant_id', restaurantId).not('retailer_id', 'is', null)
      .is('archived_at', null)
      .order('time_slot', { ascending: true }).order('name', { ascending: true });

    if (error) throw error;
    if (!rawItems?.length) return res.status(404).json({ error: 'No menu items found' });

    const seen  = new Set();
    const items = rawItems.filter(item => {
      if (seen.has(item.retailer_id)) return false;
      seen.add(item.retailer_id); return true;
    });

    const baseUrl    = process.env.FRONTEND_URL || 'https://autom8.works/';
    const escCsv     = v => { const s = String(v || '').replace(/"/g, '""'); return /[,"\n\r]/.test(s) ? `"${s}"` : s; };
    const SLOT_LABEL = { morning_tiffin: 'Morning Tiffin', lunch: 'Lunch', snacks: 'Evening Snacks', dinner: 'Dinner', all: 'All Day' };

    const csvHeader = 'id,title,description,availability,condition,price,link,image_link,brand,google_product_category,custom_label_0';
    const rows = items.map(item => [
      escCsv(item.retailer_id), escCsv(item.name), escCsv(item.description || 'Freshly prepared'),
      // Use is_stocked (not is_available) — slot rotation flips is_available hourly
      // but Meta feed should reflect permanent stock status, not current slot
      item.is_stocked !== false ? 'in stock' : 'out of stock',
      'new', escCsv(`${(item.price || 0).toFixed(2)} INR`),
      escCsv(baseUrl), escCsv(item.image_url || ''),
      'Munafe', '5765', escCsv(SLOT_LABEL[item.time_slot] || 'All Day'),
    ].join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send([csvHeader, ...rows].join('\n'));
    console.log(`[catalog-feed] ✅ Served ${items.length} items`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/feed/template', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const restaurantId = req.restaurant_id || req.query.restaurant_id || process.env.DEFAULT_RESTAURANT_ID;
    if (!restaurantId) return res.status(403).json({ error: 'No restaurant outlet linked to this account' });

    const { data: tenant } = await supabaseAdmin
      .from('tenants')
      .select('lob_type')
      .eq('id', restaurantId)
      .maybeSingle();
    const lobType = String(tenant?.lob_type || 'restaurant').toLowerCase();
    const packagedLob = ['food_products', 'retail', 'b2b', 'psl', 'jewellery'].includes(lobType);

    if (packagedLob) {
      let LOB_SCHEMAS;
      try {
        ({ LOB_SCHEMAS } = require('../../config/catalogSchemas'));
      } catch (_) {
        LOB_SCHEMAS = null;
      }
      const schema = LOB_SCHEMAS?.food_products || LOB_SCHEMAS?.[lobType];
      const headers = schema?.templateHeaders || [];

      const { data: rawItems, error } = await supabaseAdmin
        .from('menu_items')
        .select(`
          retailer_id, name, description, price, image_url, is_stocked, is_available, category,
          item_type, variant_group_id, pack_size_label, size_label, weight_grams, current_stock,
          availability_status, launch_at, deposit_amount, shelf_life_days, made_on_date,
          ingredients, allergens, meta, bundle_components, image_url_2, image_url_3, image_url_4,
          image_url_5, discount_percent, discount_ends_at, low_stock_alert_units
        `)
        .eq('restaurant_id', restaurantId)
        .not('retailer_id', 'is', null)
        .is('archived_at', null)
        .order('category', { ascending: true })
        .order('name', { ascending: true });
      if (error) throw error;

      if (!rawItems?.length) {
        const examples = (schema?.templateExamples || []).map((row) => {
          const obj = {};
          headers.forEach((h, i) => { obj[h] = row[i] != null ? row[i] : ''; });
          return obj;
        });
        return res.json({
          success: true,
          lob_type: lobType,
          source: 'examples',
          headers,
          items: examples,
          total: examples.length,
        });
      }

      const seen = new Set();
      const items = [];
      for (const item of rawItems) {
        const key = String(item.retailer_id || '').toUpperCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const comps = Array.isArray(item.meta?.bundle_components)
          ? item.meta.bundle_components.map((c) => `${c.retailer_id}:${c.qty || 1}`).join(',')
          : (item.bundle_components || '');
        let discountDays = '';
        if (item.discount_ends_at) {
          const ms = new Date(item.discount_ends_at).getTime() - Date.now();
          if (ms > 0) discountDays = Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
        }
        items.push({
          id: item.retailer_id,
          title: item.name || '',
          description: item.description || '',
          price: Number(item.price) || 0,
          category: exportCategoryLabel(item.category),
          image_link: item.image_url || '',
          is_available: (item.is_stocked !== false && item.is_available !== false) ? 'TRUE' : 'FALSE',
          item_type: item.item_type || 'PRODUCT',
          variant_group_id: item.variant_group_id || '',
          pack_size_label: item.pack_size_label || item.size_label || '',
          weight_grams: item.weight_grams ?? '',
          current_stock: item.current_stock ?? '',
          availability_status: item.availability_status || '',
          launch_at: item.launch_at || '',
          deposit_amount: item.deposit_amount ?? '',
          shelf_life_days: item.shelf_life_days ?? '',
          made_on_date: item.made_on_date || '',
          ingredients: item.ingredients || '',
          allergens: item.allergens || '',
          bundle_components: comps,
          image_url_2: item.image_url_2 || '',
          image_url_3: item.image_url_3 || '',
          image_url_4: item.image_url_4 || '',
          image_url_5: item.image_url_5 || '',
          discount_percent: item.discount_percent || '',
          discount_days: discountDays,
          low_stock_alert_units: item.low_stock_alert_units ?? 5,
        });
      }

      return res.json({
        success: true,
        lob_type: lobType,
        source: 'live',
        headers,
        items,
        total: items.length,
      });
    }

    const { data: rawItems, error } = await supabaseAdmin
      .from('menu_items')
      .select(`
        retailer_id, name, description, price, image_url, is_stocked, is_available, category,
        time_slot, prep_time_fixed, batch_size, time_per_batch, kitchen_station, packing_time,
        holds_well, fulfillment_section
      `)
      .eq('restaurant_id', restaurantId).not('retailer_id', 'is', null)
      .eq('is_stocked', true)
      .is('archived_at', null)
      .order('category', { ascending: true }).order('name', { ascending: true });

    if (error) throw error;
    if (!rawItems?.length) {
      return res.json({ success: true, lob_type: lobType, source: 'empty', items: [], total: 0 });
    }

    const seen  = new Set();
    const items = rawItems.filter(item => {
      if (seen.has(item.retailer_id)) return false;
      seen.add(item.retailer_id); return true;
    });

    const rows = items.map(item => ({
      id:                 item.retailer_id,
      title:              item.name || '',
      description:        item.description || '',
      price:              Number(item.price) || 0,
      category:           exportCategoryLabel(item.category),
      custom_label_0:     exportTimeSlotLabel(item.time_slot),
      image_link:         item.image_url || '',
      is_available:       (item.is_stocked !== false && item.is_available !== false) ? 'TRUE' : 'FALSE',
      prep_time_fixed:    item.prep_time_fixed ?? 5,
      batch_size:         item.batch_size ?? 1,
      time_per_batch:     item.time_per_batch ?? 10,
      kitchen_station:    item.kitchen_station || 'assembly',
      packing_time:       item.packing_time ?? 1,
      holds_well:         item.holds_well ? 'TRUE' : 'FALSE',
      fulfillment_section: item.fulfillment_section || 'main',
    }));

    res.json({ success: true, lob_type: lobType, source: 'live', items: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET internal menu — Python chat service ───────────────────────────────────
//   /api/catalog/internal-menu
//   /api/internal/menu-items  (alias registered in server.js)

async function handleInternalMenuItems(req, res) {
  try {
    if (req.headers['x-internal-secret'] !== getKdsSecret())
      return res.status(403).json({ error: 'Forbidden' });
    const restaurantId = req.query.restaurant_id;
    if (!restaurantId) return res.status(400).json({ error: 'restaurant_id required' });

    const { data, error } = await supabaseAdmin.from('menu_items')
      .select('id, name, description, price, image_url, time_slot, retailer_id, is_available, is_stocked, category, is_special_today, is_todays_special, special_note, applicable_slots')
      .eq('restaurant_id', restaurantId)
      .eq('is_available', true)
      .is('archived_at', null)
      .order('time_slot', { ascending: true }).order('name', { ascending: true });

    if (error) throw error;
    res.json({ success: true, count: data.length, items: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

router.get('/internal-menu', handleInternalMenuItems);

// ── POST /api/internal/deduct-stock — Python prepay fulfill / REPEAT ─────────

async function handleInternalDeductStock(req, res) {
  try {
    if (req.headers['x-internal-secret'] !== getKdsSecret())
      return res.status(403).json({ error: 'Forbidden' });

    const restaurantId = req.body.restaurant_id;
    const lines = req.body.lines || [];
    const bookingId = req.body.booking_id || null;
    if (!restaurantId || !Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ error: 'restaurant_id and lines required' });
    }

    // Idempotent: skip if booking already deducted
    if (bookingId) {
      const { data: booking } = await supabaseAdmin
        .from('bookings')
        .select('id, meta')
        .eq('id', bookingId)
        .maybeSingle();
      const meta = booking?.meta && typeof booking.meta === 'object' ? booking.meta : {};
      if (meta.stock_deducted_at) {
        return res.json({ ok: true, skipped: true, reason: 'already_deducted' });
      }
    }

    const { deductStockForLines } = require('../../helpers/inventory');
    const { maybeSendStockAlerts } = require('../../helpers/stockAlerts');
    const result = await deductStockForLines(supabaseAdmin, restaurantId, lines);
    if (!result.ok) {
      return res.status(409).json({ ok: false, shortages: result.shortages });
    }

    maybeSendStockAlerts(supabaseAdmin, restaurantId, result.updates || []).catch((e) =>
      console.warn('[internal/deduct-stock] alerts:', e.message),
    );

    if (bookingId) {
      const { data: booking } = await supabaseAdmin
        .from('bookings')
        .select('meta')
        .eq('id', bookingId)
        .maybeSingle();
      const meta = booking?.meta && typeof booking.meta === 'object' ? { ...booking.meta } : {};
      meta.stock_deducted_at = new Date().toISOString();
      await supabaseAdmin.from('bookings').update({ meta }).eq('id', bookingId);
    }

    res.json({ ok: true, updates: result.updates || [] });
  } catch (err) {
    console.error('[internal/deduct-stock]', err.message);
    res.status(500).json({ error: err.message });
  }
}

router.post('/internal/deduct-stock', handleInternalDeductStock);

// ── POST /api/internal/validate-cart — REPEAT live stock + reprice ───────────

async function handleInternalValidateCart(req, res) {
  try {
    if (req.headers['x-internal-secret'] !== getKdsSecret())
      return res.status(403).json({ error: 'Forbidden' });

    const restaurantId = req.body.restaurant_id;
    const lines = req.body.lines || [];
    if (!restaurantId || !Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ error: 'restaurant_id and lines required' });
    }

    const { validateAndPriceLines } = require('../../helpers/inventory');
    const result = await validateAndPriceLines(supabaseAdmin, restaurantId, lines);
    if (!result.ok) {
      return res.status(409).json({
        ok: false,
        shortages: result.shortages || [],
        lines: result.lines || [],
        total: result.total || 0,
      });
    }
    res.json({
      ok: true,
      lines: result.lines,
      total: result.total,
      shortages: [],
    });
  } catch (err) {
    console.error('[internal/validate-cart]', err.message);
    res.status(500).json({ error: err.message });
  }
}

router.post('/internal/validate-cart', handleInternalValidateCart);

module.exports = router;
module.exports.handleInternalMenuItems = handleInternalMenuItems;
module.exports.handleInternalDeductStock = handleInternalDeductStock;
module.exports.handleInternalValidateCart = handleInternalValidateCart;
