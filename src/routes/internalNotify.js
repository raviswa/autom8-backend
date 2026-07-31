'use strict';

/**
 * Internal service-to-service WhatsApp notify.
 * Used by autom8-support (and other services) — not for browser clients.
 *
 * Auth: x-internal-secret / Bearer / body.secret === AUTOM8_KDS_SECRET
 *
 * POST /api/internal/notify/whatsapp
 * Body: { to, message, restaurant_id? }
 */

const express = require('express');
const router = express.Router();
const {
  getKdsSecret,
  isValidKdsSecret,
  extractInternalSecret,
} = require('../config/internalSecret');
const { sendWhatsAppMessage } = require('../helpers/whatsapp');

router.post('/notify/whatsapp', async (req, res) => {
  try {
    if (!isValidKdsSecret(extractInternalSecret(req))) {
      return res.status(401).json({ error: 'Invalid internal secret' });
    }

    const to = String(req.body?.to || req.body?.phone || '').replace(/\D/g, '');
    const message = String(req.body?.message || '').trim();
    const restaurantId = req.body?.restaurant_id || null;

    if (to.length < 10) {
      return res.status(400).json({ error: 'to (phone) is required' });
    }
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const ok = await sendWhatsAppMessage(to, message, restaurantId);
    if (!ok) {
      return res.status(502).json({ error: 'WhatsApp send failed or not configured' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[internal/notify/whatsapp]', err.message);
    return res.status(500).json({ error: err.message || 'Notify failed' });
  }
});

// Health ping for support service wiring checks
router.get('/notify/health', (req, res) => {
  if (!isValidKdsSecret(extractInternalSecret(req))) {
    return res.status(401).json({ error: 'Invalid internal secret' });
  }
  try {
    getKdsSecret();
    return res.json({ ok: true, service: 'internal-notify' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
