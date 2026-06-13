// src/routes/subscription.js
// ============================================================================
// Subscription / feature-flag endpoint
//
// GET /api/subscription — Returns billing plan, paid features, and enabled
//                         features for the authenticated restaurant.
//
// paid_features    → what the restaurant has paid for (billing gate)
// enabled_features → what is currently active (Settings → Services toggles)
// features           → alias for enabled_features (backward compatibility)
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin } = require('../config/supabase');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');
const { requireKdsSecret } = require('../middleware/internalAuth');
const {
  ALL_FEATURES,
  ORDER_SERVICES,
  resolvePaidFeatures,
  resolveEnabledFeatures,
  enabledOrderServices,
  mergeEnabledFeatures,
  validateEnabledFeatures,
} = require('../helpers/subscriptionFeatures');

// ── GET /api/subscription ─────────────────────────────────────────────────────

router.get('/', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data: restaurant } = await supabaseAdmin
      .from('restaurants')
      .select('subscribed_features, name')
      .eq('id', req.restaurant_id)
      .single();

    const { data: sub } = await supabaseAdmin
      .from('restaurant_subscriptions')
      .select('plan, status, trial_ends_at, renews_at, base_price, final_price, billing_cycle, features')
      .eq('restaurant_id', req.restaurant_id)
      .maybeSingle();

    const paidFeatures    = resolvePaidFeatures(sub);
    const enabledFeatures = resolveEnabledFeatures(restaurant, paidFeatures);
    const enabledServices = enabledOrderServices(enabledFeatures);

    const plan   = sub?.plan   ?? (sub ? sub.status : 'trial');
    const status = sub?.status ?? 'trial';

    const now         = new Date();
    const trialActive = sub?.trial_ends_at ? new Date(sub.trial_ends_at) > now : true;
    const isActive    = status === 'active' || (status === 'trial' && trialActive);

    res.json({
      success:          true,
      plan:             sub?.billing_cycle === 'annual' ? `${plan}_annual` : plan,
      status,
      is_active:        isActive,
      trial_ends_at:    sub?.trial_ends_at   ?? null,
      renews_at:        sub?.renews_at       ?? null,
      price:            sub?.final_price     ?? 0,
      billing_cycle:    sub?.billing_cycle   ?? 'monthly',
      paid_features:    paidFeatures,
      enabled_features: enabledFeatures,
      enabled_services: enabledServices,
      features:         enabledFeatures,
      subscribed_features: enabledFeatures,
    });
  } catch (err) {
    console.error('[subscription]', err.message);
    res.json({
      success:          true,
      plan:             'trial',
      status:           'trial',
      is_active:        true,
      paid_features:    ALL_FEATURES,
      enabled_features: ALL_FEATURES,
      enabled_services: ['dine_in', 'takeaway', 'delivery', 'reserve_table'],
      features:         ALL_FEATURES,
      subscribed_features: ALL_FEATURES,
    });
  }
});

// ── PUT /api/subscription/paid-features ───────────────────────────────────────
// Billing / ops only (AUTOM8_KDS_SECRET). Sets what the restaurant has paid for.
// Clamps enabled features to remain within the new paid plan.

router.put('/paid-features', requireKdsSecret, async (req, res) => {
  try {
    const { restaurant_id, paid_features } = req.body;
    if (!restaurant_id) {
      return res.status(400).json({ error: 'restaurant_id is required' });
    }
    if (!Array.isArray(paid_features) || paid_features.length < 1) {
      return res.status(400).json({ error: 'paid_features must be a non-empty array' });
    }

    const unknown = paid_features.filter(f => !ALL_FEATURES.includes(f));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown features: ${unknown.join(', ')}` });
    }

    const servicesInPlan = paid_features.filter(f => ORDER_SERVICES.includes(f));
    if (servicesInPlan.length < 1) {
      return res.status(400).json({ error: 'Paid plan must include at least one order service' });
    }

    const { data: restaurant } = await supabaseAdmin
      .from('restaurants')
      .select('subscribed_features')
      .eq('id', restaurant_id)
      .single();
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const currentEnabled = resolveEnabledFeatures(restaurant, paid_features);
    const enabledServices = enabledOrderServices(currentEnabled)
      .filter(s => paid_features.includes(s));
    const nextEnabled = mergeEnabledFeatures(
      enabledServices.length ? enabledServices : servicesInPlan.slice(0, 1),
      paid_features,
    );

    const check = validateEnabledFeatures(nextEnabled, paid_features);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const { data: sub } = await supabaseAdmin
      .from('restaurant_subscriptions')
      .select('id')
      .eq('restaurant_id', restaurant_id)
      .maybeSingle();

    if (sub) {
      await supabaseAdmin
        .from('restaurant_subscriptions')
        .update({ features: paid_features, updated_at: new Date().toISOString() })
        .eq('restaurant_id', restaurant_id);
    } else {
      const trialEnds = new Date();
      trialEnds.setDate(trialEnds.getDate() + 30);
      await supabaseAdmin.from('restaurant_subscriptions').insert({
        restaurant_id,
        features:      paid_features,
        status:        'active',
        billing_cycle: 'monthly',
        base_price:    0,
        discount_pct:  0,
        final_price:   0,
        trial_ends_at: trialEnds.toISOString(),
      });
    }

    await supabaseAdmin
      .from('restaurants')
      .update({ subscribed_features: nextEnabled, updated_at: new Date().toISOString() })
      .eq('id', restaurant_id);

    res.json({
      success:          true,
      restaurant_id,
      paid_features,
      enabled_features: nextEnabled,
      enabled_services: enabledOrderServices(nextEnabled),
    });
  } catch (err) {
    console.error('[subscription/paid-features]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
