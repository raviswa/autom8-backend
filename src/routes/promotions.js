'use strict';

/**
 * Tenant JWT APIs for customer webcart promo codes.
 *
 *   GET    /api/promotions
 *   POST   /api/promotions
 *   PUT    /api/promotions/:id
 *   GET    /api/promotions/:id/redemptions
 *   GET    /api/promotions/redemptions
 */

const express = require('express');
const router = express.Router();

const { authenticateToken, getRestaurantId } = require('../middleware/auth');
const {
  listPromoCodes,
  createPromoCode,
  updatePromoCode,
  listRedemptions,
} = require('../helpers/tenantPromoCodes');

router.use(authenticateToken, getRestaurantId);

function requireRestaurant(req, res) {
  if (!req.restaurant_id) {
    res.status(400).json({ error: 'No outlet selected' });
    return false;
  }
  return true;
}

router.get('/', async (req, res) => {
  try {
    if (!requireRestaurant(req, res)) return;
    const items = await listPromoCodes(req.restaurant_id);
    res.json({ success: true, promotions: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    if (!requireRestaurant(req, res)) return;
    const role = req.user?.role || req.employee?.role;
    if (!['owner', 'brand_owner', 'brand_manager', 'manager'].includes(role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const promo = await createPromoCode(req.restaurant_id, req.body || {});
    res.status(201).json({ success: true, promotion: promo });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/redemptions', async (req, res) => {
  try {
    if (!requireRestaurant(req, res)) return;
    const items = await listRedemptions(req.restaurant_id, null, {
      limit: parseInt(req.query.limit, 10) || 50,
    });
    res.json({ success: true, redemptions: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!requireRestaurant(req, res)) return;
    const role = req.user?.role || req.employee?.role;
    if (!['owner', 'brand_owner', 'brand_manager', 'manager'].includes(role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const promo = await updatePromoCode(req.restaurant_id, req.params.id, req.body || {});
    res.json({ success: true, promotion: promo });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/:id/redemptions', async (req, res) => {
  try {
    if (!requireRestaurant(req, res)) return;
    const items = await listRedemptions(req.restaurant_id, req.params.id, {
      limit: parseInt(req.query.limit, 10) || 50,
    });
    res.json({ success: true, redemptions: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
