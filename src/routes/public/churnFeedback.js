'use strict';

/**
 * Public churn feedback (no tenant JWT).
 * Token is HMAC-signed in miss-you emails (see churnReminders.signFeedbackToken).
 */

const express = require('express');
const router = express.Router();

const { supabaseAdmin } = require('../../config/supabase');
const {
  FEEDBACK_REASONS,
  verifyFeedbackToken,
} = require('../../helpers/churnReminders');

async function submitFeedback(req, res) {
  try {
    const token = req.body?.token || req.query?.token;
    const reason = String(req.body?.reason || req.query?.reason || '').trim().toLowerCase();
    const note = String(req.body?.note || req.query?.note || '').trim().slice(0, 1000) || null;

    const payload = verifyFeedbackToken(token);
    if (!payload?.tid) {
      return res.status(400).json({ error: 'Invalid or expired feedback link' });
    }
    if (!FEEDBACK_REASONS.includes(reason)) {
      return res.status(400).json({
        error: 'Invalid reason',
        allowed: FEEDBACK_REASONS,
      });
    }

    const { error } = await supabaseAdmin.from('churn_feedback').insert({
      tenant_id: payload.tid,
      reason,
      note,
      submitted_at: new Date().toISOString(),
    });
    if (error) return res.status(500).json({ error: error.message });

    // Friendly HTML for email link taps
    if (req.method === 'GET' || String(req.headers.accept || '').includes('text/html')) {
      return res
        .status(200)
        .type('html')
        .send(`<!doctype html><html><head><meta charset="utf-8"><title>Thanks</title></head>
<body style="font-family:system-ui;padding:40px;max-width:480px;margin:auto">
  <h1>Thanks</h1>
  <p>We recorded your feedback. You can close this tab.</p>
</body></html>`);
    }

    res.json({ success: true, message: 'Thanks — we recorded your feedback.' });
  } catch (err) {
    console.error('[public/churn-feedback]', err.message);
    res.status(500).json({ error: err.message });
  }
}

router.post('/churn-feedback', submitFeedback);
router.get('/churn-feedback', submitFeedback);

module.exports = router;
