'use strict';

/**
 * Internal refill cycle create — called by chat after payment_status=paid.
 *
 * POST /api/internal/refill/cycles
 * Auth: x-internal-secret / Bearer / body.secret === AUTOM8_KDS_SECRET
 * Body: { booking_id }
 */

const express = require('express');
const router = express.Router();
const {
  isValidKdsSecret,
  extractInternalSecret,
} = require('../config/internalSecret');
const { createRefillCyclesForBooking } = require('../helpers/refillCycles');

router.post('/refill/cycles', async (req, res) => {
  try {
    if (!isValidKdsSecret(extractInternalSecret(req))) {
      return res.status(401).json({ error: 'Invalid internal secret' });
    }

    const bookingId = String(req.body?.booking_id || '').trim();
    if (!bookingId) {
      return res.status(400).json({ error: 'booking_id is required' });
    }

    const result = await createRefillCyclesForBooking(bookingId);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[internal/refill/cycles]', err.message);
    return res.status(500).json({ error: err.message || 'Refill cycle create failed' });
  }
});

module.exports = router;
