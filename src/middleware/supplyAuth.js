'use strict';

/**
 * Soft-lock attach for supply routes.
 *
 * Soft-lock condition (must match billingReminders + feature_gate):
 *   daysPast(cycleAnchor) >= GRACE_PERIOD_DAYS  (default 15, env SUBSCRIPTION_GRACE_PERIOD_DAYS)
 * Status set by reminder job when unpaid: supplier_subscriptions.status = 'overdue'
 * (date math is authoritative — status alone does not unlock/lock).
 */

const { supabaseAdmin } = require('../config/supabase');
const {
  isSubscriptionSoftLocked,
  buildLapsedPayload,
  LAPSED_ERROR,
} = require('../helpers/subscriptionAccess');

async function getSupplierContext(req, res, next) {
  try {
    const authUserId = req.user?.sub;

    if (!authUserId) {
      return res.status(401).json({ error: 'Authenticated user not found on request' });
    }

    const { data: supplier, error } = await supabaseAdmin
      .from('suppliers')
      .select([
        'id', 'name', 'business_name', 'email', 'phone',
        'waba_phone', 'waba_phone_number_id',
        'gstin', 'address', 'city', 'state', 'pincode',
        'logo_url', 'ordering_open_time', 'ordering_cutoff_time',
        'always_open', 'timezone', 'is_active', 'lob_type',
      ].join(', '))
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    if (error) {
      console.error('[supplyAuth] DB error fetching supplier context:', error.message);
      return res.status(500).json({ error: 'Failed to load supplier profile' });
    }

    if (!supplier) {
      return res.status(403).json({
        error: 'No supplier account found for this user. Contact support.',
      });
    }

    if (!supplier.is_active) {
      return res.status(403).json({
        error: 'Your supplier account has been deactivated. Contact support.',
      });
    }

    req.supplier = supplier;
    req.supplier_id = supplier.id;

    try {
      const { data: sub } = await supabaseAdmin
        .from('supplier_subscriptions')
        .select('id, status, trial_ends_at, renews_at')
        .eq('supplier_id', supplier.id)
        .maybeSingle();
      req.supplier_subscription = sub || null;
      req.subscription_lapsed = isSubscriptionSoftLocked(sub);
      if (req.subscription_lapsed) {
        req.subscription_lapsed_payload = buildLapsedPayload(sub || {});
      }
    } catch (subErr) {
      console.warn('[supplyAuth] subscription lookup failed (non-fatal):', subErr.message);
      req.supplier_subscription = null;
      req.subscription_lapsed = false;
    }

    next();
  } catch (err) {
    console.error('[supplyAuth] Unexpected error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

/**
 * Soft-lock write gate — 402 with machine-readable subscription_lapsed.
 * Apply on new orders, order-link sends, marketing — not on reads/payments.
 */
function requireSubscriptionWrite(req, res, next) {
  if (!req.subscription_lapsed) return next();
  const body = req.subscription_lapsed_payload || {
    error: LAPSED_ERROR,
    message: 'Subscription expired. Please renew to continue.',
  };
  return res.status(402).json(body);
}

module.exports = {
  getSupplierContext,
  supplyAuthMiddleware: getSupplierContext,
  authenticateSupplyToken: getSupplierContext,
  requireSubscriptionWrite,
};
