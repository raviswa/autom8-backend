'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin } = require('../../config/supabase');
const { authenticateToken, getRestaurantId } = require('../../middleware/auth');
const { normalizeSlotArray } = require('./shared/applicableSlots');

router.get('/menu-categories/slots', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('menu_categories')
      .select('name, applicable_slots')
      .eq('restaurant_id', req.restaurant_id)
      .order('name', { ascending: true });
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/menu-categories/:name/slots', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const name = String(req.params.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Category name is required' });

    const applicableSlots = normalizeSlotArray(req.body?.applicable_slots);
    const patch = {
      restaurant_id: req.restaurant_id,
      name,
      applicable_slots: applicableSlots,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabaseAdmin
      .from('menu_categories')
      .upsert(patch, { onConflict: 'restaurant_id,name' });
    if (error) throw error;

    res.json({ success: true, category: name, applicable_slots: applicableSlots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/menu-items/:id/slots', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const slots = req.body?.applicable_slots;
    const normalized = slots == null ? null : normalizeSlotArray(slots);
    const { error } = await supabaseAdmin.from('menu_items').update({
      applicable_slots: normalized,
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id);
    if (error) throw error;
    res.json({ success: true, id: req.params.id, applicable_slots: normalized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
