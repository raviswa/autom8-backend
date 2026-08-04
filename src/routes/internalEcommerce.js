'use strict';

/**
 * Internal ecommerce order push — called by chat after payment_status=paid.
 *
 * POST /api/internal/ecommerce/push
 * Auth: x-internal-secret / Bearer / body.secret === AUTOM8_KDS_SECRET
 * Body: { booking_id }
 */

const express = require('express');
const router = express.Router();
const {
  isValidKdsSecret,
  extractInternalSecret,
} = require('../config/internalSecret');
const { pushEcommerceOrders } = require('../integrations/ecommerce');

router.post('/ecommerce/push', async (req, res) => {
  try {
    if (!isValidKdsSecret(extractInternalSecret(req))) {
      return res.status(401).json({ error: 'Invalid internal secret' });
    }

    const bookingId = String(req.body?.booking_id || '').trim();
    if (!bookingId) {
      return res.status(400).json({ error: 'booking_id is required' });
    }

    const result = await pushEcommerceOrders(bookingId, {
      items: Array.isArray(req.body?.items) ? req.body.items : undefined,
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[internal/ecommerce/push]', err.message);
    return res.status(500).json({ error: err.message || 'Ecommerce push failed' });
  }
});

module.exports = router;
