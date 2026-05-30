// src/routes/marketing.js
// ============================================================================
// Marketing / WABA strip endpoints
// Mounted at /api/marketing and /api/restaurants in server.js
// ============================================================================

const express      = require('express');
const router       = express.Router();
const { supabaseAdmin } = require('../config/supabase');

// GET /api/restaurants/:id  (used by WABAStrip component)
// GET /api/marketing/:id    (same, alternate path)
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('restaurants')
      .select('id, name, waba_id, whatsapp_number, whatsapp_phone_number, whatsapp_display_name, is_active')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) {
      console.error('[marketing/:id]', error.message);
      return res.status(500).json({ error: error.message });
    }
    if (!data) return res.status(404).json({ error: 'Restaurant not found' });
    res.json({ success: true, restaurant: data });
  } catch (err) {
    console.error('[marketing/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/restaurants  (list all active, used by WABAStrip fallback)
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('restaurants')
      .select('id, name, waba_id, whatsapp_number, whatsapp_phone_number, is_active')
      .eq('is_active', true);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, restaurants: data ?? [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
