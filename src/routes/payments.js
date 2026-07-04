// src/routes/payments.js
// ============================================================================
// NEW FILE — Issue 3 fix (payment approval gating and webview race).
//
// Root cause recap: the reported symptom ("initial failure on UPI/simulate path,
// then already-paid on retry, receipt already sent on WhatsApp") is the classic
// signature of a payment-complete webview trusting the Razorpay client-side
// redirect/callback query params as the source of truth. The backend webhook
// (tools/prepay_fulfillment.py::fulfill_from_webhook) is already idempotent and
// may settle the booking as paid *before* the browser's redirect makes it back to
// the client — if the redirect carries a stale "failed"/"cancelled" reason (flaky
// network, backgrounded webview, etc.), a front-end that trusts that param alone
// will show failure even though the order already went through.
//
// This endpoint is the single authoritative read of "did this booking actually
// get paid" that the payment-complete page must poll instead of trusting the
// redirect query string. Contract for the front-end:
//   - On landing (regardless of what the redirect param says), poll this endpoint
//     every ~2s for up to ~20s.
//   - If payment_status === 'paid' at any point, render success immediately —
//     even if the redirect said failed/cancelled.
//   - Only render a genuine failure screen if the poll window expires and the
//     booking is still 'pending'.
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin } = require('../config/supabase');

// ── GET /api/payments/booking-status/:bookingId ───────────────────────────────
// Public-ish read (no auth middleware) since the payment-complete webview is
// reached via a Razorpay redirect without a logged-in session. Only exposes the
// minimal fields a payment-complete screen needs — no customer PII, no totals.
router.get('/booking-status/:bookingId', async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!bookingId) {
      return res.status(400).json({ error: 'bookingId is required' });
    }

    const { data: booking, error } = await supabaseAdmin
      .from('bookings')
      .select('id, status, payment_status, token_number, service_type, updated_at')
      .eq('id', bookingId)
      .maybeSingle();

    if (error) throw error;
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    console.log(
      `[payment-status] booking=${booking.id} payment_status=${booking.payment_status} ` +
      `status=${booking.status} (source=db-read)`
    );

    res.json({
      success: true,
      booking_id: booking.id,
      payment_status: booking.payment_status,   // 'paid' | 'pending' | 'refunded'
      status: booking.status,                   // 'pending' | 'confirmed' | 'cancelled' | 'rejected'
      token_number: booking.token_number,
      service_type: booking.service_type,
      updated_at: booking.updated_at,
    });
  } catch (err) {
    console.error('[payment-status] lookup failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// ─── Wiring note ───────────────────────────────────────────────────────────
// In server.js (or wherever routes are mounted), add:
//   app.use('/api/payments', require('./routes/payments'));
// This does not replace or modify any existing Razorpay webhook route — it is
// purely an additive read endpoint for the front-end payment-complete page.