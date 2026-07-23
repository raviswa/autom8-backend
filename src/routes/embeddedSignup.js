// src/routes/embeddedSignup.js
// Additive WhatsApp Embedded Signup (Tech Provider) — does not alter webhook/send paths.
//
// GET  /config   — public IDs for FB.init / FB.login (no secrets)
// POST /complete — exchange code, subscribe WABA, register phone, persist credentials

'use strict';

const express = require('express');
const router  = express.Router();

const {
  completeEmbeddedSignupForRestaurant,
  getPublicEmbeddedSignupConfig,
} = require('../helpers/embeddedSignupComplete');
const {
  authenticateToken,
  getRestaurantId,
  canManageRestaurantSettings,
} = require('../middleware/auth');

function requireSettingsAccess(req, res, next) {
  if (!canManageRestaurantSettings(req.user_role))
    return res.status(403).json({ error: 'Unauthorized' });
  if (!req.restaurant_id)
    return res.status(403).json({ error: 'No restaurant outlet linked to this account' });
  next();
}

// ── GET /config — no auth; never returns secrets ─────────────────────────────
router.get('/config', (_req, res) => {
  res.json(getPublicEmbeddedSignupConfig());
});

// ── POST /complete ───────────────────────────────────────────────────────────
router.post('/complete', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {
    const {
      code,
      waba_id,
      phone_number_id,
      display_phone_number,
    } = req.body || {};

    const result = await completeEmbeddedSignupForRestaurant(req.restaurant_id, {
      code,
      waba_id,
      phone_number_id,
      display_phone_number,
      actorId: req.user?.sub || null,
    });

    res.json({
      success: true,
      waba_id: result.waba_id,
      phone_number_id: result.phone_number_id,
      whatsapp_number: result.whatsapp_number,
      integration_id: result.integration_id,
      next_step: 'Add a payment method in WhatsApp Manager if not already done, then send Hi to your number to test.',
    });
  } catch (err) {
    console.error('[embedded-signup] complete failed:', err.message, err.graph || '');
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 400;
    res.status(status).json({
      error: err.message || 'Embedded Signup completion failed',
      graph: err.graph || undefined,
    });
  }
});

module.exports = router;
