'use strict';

/**
 * Admin referral + email test routes.
 * Protected with requireKdsSecret (same pattern as PUT /api/subscription/paid-features).
 *
 *   POST /api/admin/referrals
 *   GET  /api/admin/referrals
 *   GET  /api/admin/referral-tiers
 *   POST /api/admin/test-email
 *   POST /api/admin/internal/first-message   — chat service → stamp + credit
 */

const express = require('express');
const router = express.Router();

const { requireKdsSecret } = require('../../middleware/internalAuth');
const {
  createReferral,
  listReferrals,
  getTierStatus,
  markFirstMessageAndCreditReferral,
  creditReferralIfPending,
} = require('../../helpers/referrals');
const { sendEmail } = require('../../config/mailer');

router.use(requireKdsSecret);

// ── POST /api/admin/referrals ─────────────────────────────────────────────────
router.post('/referrals', async (req, res) => {
  try {
    const {
      referrer_restaurant_id,
      referred_type,
      referred_id,
      created_by,
    } = req.body || {};

    const result = await createReferral({
      referrerRestaurantId: referrer_restaurant_id,
      referredType: referred_type,
      referredId: referred_id,
      createdBy: created_by || req.headers['x-admin-actor'] || 'admin',
    });

    res.status(201).json({
      success: true,
      referral: result.referral,
      tier_at_create: result.tier,
      credit: result.creditResult,
    });
  } catch (err) {
    const status =
      err.code === 'duplicate_referral' ? 409
        : err.code === 'referred_not_found' || err.code === 'referrer_not_found' || err.code === 'invalid_referred_type' || err.code === 'validation'
          ? 400
          : 500;
    if (status === 500) {
      console.error('[admin/referrals] create failed', { error: err.message });
    }
    res.status(status).json({ error: err.message, code: err.code || null });
  }
});

// ── GET /api/admin/referrals ──────────────────────────────────────────────────
router.get('/referrals', async (req, res) => {
  try {
    const referrals = await listReferrals();
    res.json({ success: true, referrals });
  } catch (err) {
    console.error('[admin/referrals] list failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/referral-tiers ─────────────────────────────────────────────
router.get('/referral-tiers', async (req, res) => {
  try {
    const status = await getTierStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    console.error('[admin/referral-tiers] failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/test-email ────────────────────────────────────────────────
router.post('/test-email', async (req, res) => {
  try {
    const to = (req.body?.to || '').trim();
    if (!to) return res.status(400).json({ error: 'to is required' });

    const result = await sendEmail({
      to,
      subject: 'Autom8 test email',
      text: 'This is a test email from the Autom8 Gmail SMTP mailer. If you received it, GMAIL_USER + GMAIL_APP_PASSWORD are working.',
      html: '<p>This is a test email from the Autom8 Gmail SMTP mailer.</p><p>If you received it, <code>GMAIL_USER</code> + <code>GMAIL_APP_PASSWORD</code> are working.</p>',
    });

    if (!result.sent) {
      return res.status(503).json({
        success: false,
        error: 'Email not sent',
        reason: result.reason || null,
      });
    }

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[admin/test-email] failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/internal/first-message ────────────────────────────────────
// Called from Python chat after restaurant resolve. Idempotent.
router.post('/internal/first-message', async (req, res) => {
  try {
    const restaurantId = req.body?.restaurant_id;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurant_id is required' });
    }

    const result = await markFirstMessageAndCreditReferral(restaurantId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[admin/internal/first-message] failed', {
      restaurant_id: req.body?.restaurant_id,
      error: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/internal/credit-referral ──────────────────────────────────
// Optional explicit credit (e.g. ops replay). Same RPC as automatic triggers.
router.post('/internal/credit-referral', async (req, res) => {
  try {
    const { referred_type, referred_id } = req.body || {};
    if (!referred_type || !referred_id) {
      return res.status(400).json({ error: 'referred_type and referred_id are required' });
    }
    const result = await creditReferralIfPending(referred_type, referred_id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[admin/internal/credit-referral] failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
