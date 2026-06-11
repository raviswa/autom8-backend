// src/routes/referrals.js
// ============================================================================
// Referral management REST endpoints
//
// POST /api/referrals/validate  — Validate a referral code (POS/dashboard)
// POST /api/referrals/generate  — Generate / fetch a referral code for a customer
//
// WhatsApp inbound referral validation lives in waHandlers.js (validateReferralCode).
// These endpoints are for the manager dashboard and POS.
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabase, supabaseAdmin }  = require('../config/supabase');
const { authenticateToken }        = require('../middleware/auth');
const { validateReferralCode, generateReferralSharePrompt } = require('../handlers/waHandlers');

// ── POST /api/referrals/validate ──────────────────────────────────────────────

router.post('/validate', authenticateToken, async (req, res) => {
  try {
    const { customer_phone, code, restaurant_id } = req.body;
    if (!customer_phone || !code || !restaurant_id)
      return res.status(400).json({ error: 'customer_phone, code, and restaurant_id required' });

    const handled = await validateReferralCode(customer_phone, code, restaurant_id);
    res.json({ success: true, handled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/referrals/generate ─────────────────────────────────────────────

router.post('/generate', authenticateToken, async (req, res) => {
  try {
    const { data: userData } = await supabaseAdmin
      .from('employees').select('restaurant_id').eq('id', req.user.sub).single();

    const { customer_phone, customer_name } = req.body;
    if (!customer_phone) return res.status(400).json({ error: 'customer_phone required' });

    await generateReferralSharePrompt(customer_phone, userData.restaurant_id, customer_name);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
