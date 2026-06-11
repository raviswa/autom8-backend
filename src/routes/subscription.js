// src/routes/subscription.js
// ============================================================================
// Subscription / feature-flag endpoint
//
// GET /api/subscription  — Returns the active plan and enabled features
//                          for the authenticated restaurant.
//
// Replaces the hardcoded stub in server.js that always returned plan:'pro'
// regardless of the restaurant's actual subscription state.
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin } = require('../config/supabase');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');

// All features supported by Munafe (used for fallback / trial restaurants)
const ALL_FEATURES = [
  'dine_in', 'takeaway', 'delivery', 'reserve_table',
  'token_management', 'kds', 'analytics', 'marketing',
  'whatsapp_ordering', 'catalog_sync', 'reporting',
];

// ── GET /api/subscription ─────────────────────────────────────────────────────

router.get('/', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    // Fetch restaurant row for subscribed_features + subscription record
    const { data: restaurant } = await supabaseAdmin
      .from('restaurants')
      .select('subscribed_features, name')
      .eq('id', req.restaurant_id)
      .single();

    const { data: sub } = await supabaseAdmin
      .from('restaurant_subscriptions')
      .select('plan, status, trial_ends_at, renews_at, base_price, final_price, billing_cycle')
      .eq('restaurant_id', req.restaurant_id)
      .maybeSingle();

    // Features come from the restaurant row (feature flags set by Settings → Services)
    const features = restaurant?.subscribed_features?.length
      ? restaurant.subscribed_features
      : ALL_FEATURES;

    // Determine plan label
    const plan   = sub?.plan   ?? (sub ? sub.status : 'trial');
    const status = sub?.status ?? 'trial';

    // Is the trial still active?
    const now         = new Date();
    const trialActive = sub?.trial_ends_at ? new Date(sub.trial_ends_at) > now : true;
    const isActive    = status === 'active' || (status === 'trial' && trialActive);

    res.json({
      success:       true,
      plan:          sub?.billing_cycle === 'annual' ? `${plan}_annual` : plan,
      status,
      is_active:     isActive,
      trial_ends_at: sub?.trial_ends_at   ?? null,
      renews_at:     sub?.renews_at       ?? null,
      price:         sub?.final_price     ?? 0,
      billing_cycle: sub?.billing_cycle   ?? 'monthly',
      features,
    });
  } catch (err) {
    console.error('[subscription]', err.message);
    // Graceful fallback — never block the dashboard on a subscription lookup error
    res.json({
      success:   true,
      plan:      'trial',
      status:    'trial',
      is_active: true,
      features:  ALL_FEATURES,
    });
  }
});

module.exports = router;
