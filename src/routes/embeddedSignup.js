// src/routes/embeddedSignup.js
// Additive WhatsApp Embedded Signup (Tech Provider) — does not alter webhook/send paths.
//
// GET  /config        — public IDs for FB.init / FB.login (no secrets)
// POST /complete      — exchange code, subscribe WABA, register phone, persist credentials
// POST /register-pin  — retry Graph /register with existing 2FA PIN (migration)

'use strict';

const express = require('express');
const router  = express.Router();

const {
  completeEmbeddedSignupForRestaurant,
  registerPhoneWithExistingPin,
  getPublicEmbeddedSignupConfig,
  listMessageTemplatesForRestaurant,
  getWhatsAppAccountStatus,
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

router.get('/config', (_req, res) => {
  res.json(getPublicEmbeddedSignupConfig());
});

/** WhatsApp Account Status — credentials + connection health summary */
router.get('/status', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {
    const status = await getWhatsAppAccountStatus(req.restaurant_id);
    // #region agent log
    try {
      const fs = require('fs');
      const path = require('path');
      const logPath = path.join(__dirname, '..', '..', '..', 'debug-c76584.log');
      fs.appendFileSync(logPath, JSON.stringify({sessionId:'c76584',runId:'pre-deploy',hypothesisId:'D',location:'embeddedSignup.js:/status',message:'status endpoint hit',data:{connected:Boolean(status?.connected),hasWaba:Boolean(status?.waba_id),restaurantId:req.restaurant_id},timestamp:Date.now()}) + '\n');
    } catch (_) {}
    // #endregion
    res.json({ success: true, ...status });
  } catch (err) {
    console.error('[embedded-signup] status failed:', err.message);
    const statusCode = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(statusCode).json({ error: err.message || 'Could not load WhatsApp status' });
  }
});

/** Read-only Meta message template library for the connected WABA */
router.get('/templates', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {
    const result = await listMessageTemplatesForRestaurant(req.restaurant_id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[embedded-signup] templates failed:', err.message, err.graph || '');
    const statusCode = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(statusCode).json({
      error: err.message || 'Could not load message templates',
      code: err.code || undefined,
    });
  }
});

router.post('/complete', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {
    const {
      code,
      waba_id,
      phone_number_id,
      display_phone_number,
      existing_pin,
    } = req.body || {};

    const result = await completeEmbeddedSignupForRestaurant(req.restaurant_id, {
      code,
      waba_id,
      phone_number_id,
      display_phone_number,
      existing_pin: existing_pin || null,
      actorId: req.user?.sub || null,
    });

    res.json({
      success: true,
      waba_id: result.waba_id,
      phone_number_id: result.phone_number_id,
      whatsapp_number: result.whatsapp_number,
      integration_id: result.integration_id,
      whatsapp_needs_existing_pin: Boolean(result.whatsapp_needs_existing_pin),
      next_step: result.whatsapp_needs_existing_pin
        ? 'Enter the existing WhatsApp 2FA PIN to finish registering this number.'
        : 'Add a payment method in WhatsApp Manager if not already done, then send Hi to your number to test.',
    });
  } catch (err) {
    console.error('[embedded-signup] complete failed:', err.message, err.graph || '');
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 400;
    res.status(status).json({
      error: err.message || 'Embedded Signup completion failed',
      code: err.code || undefined,
      graph: err.graph || undefined,
    });
  }
});

router.post('/register-pin', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {
    const pin = req.body?.pin || req.body?.existing_pin;
    const result = await registerPhoneWithExistingPin(req.restaurant_id, pin, req.user?.sub || null);
    res.json(result);
  } catch (err) {
    console.error('[embedded-signup] register-pin failed:', err.message, err.graph || '');
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 400;
    res.status(status).json({
      error: err.message || 'PIN registration failed',
      code: err.code || undefined,
      graph: err.graph || undefined,
    });
  }
});

module.exports = router;
