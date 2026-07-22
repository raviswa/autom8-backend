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
    if (!rawItems?.length) return res.status(404).json({ error: 'No menu items found' });

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

    res.json({ success: true, items: rows, total: rows.length });
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

module.exports = router;
module.exports.handleInternalMenuItems = handleInternalMenuItems;
