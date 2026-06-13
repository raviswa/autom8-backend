'use strict';

const {
  ALL_FEATURES,
  mergeEnabledFeatures,
} = require('./subscriptionFeatures');

const DEFAULT_SERVICES = ['dine_in', 'takeaway', 'delivery', 'reserve_table'];

/**
 * Create or skip billing record for a restaurant outlet.
 * paidFeatures  = what they are charged for (billing gate)
 * enabledFeatures = what is active (may be passed explicitly)
 */
async function ensureRestaurantSubscription(supabaseAdmin, restaurantId, options = {}) {
  const paidPlan = Array.isArray(options.paidFeatures) && options.paidFeatures.length
    ? options.paidFeatures
    : ALL_FEATURES;

  let enabledFeatures = options.enabledFeatures;
  if (!enabledFeatures?.length) {
    const enabledServices = Array.isArray(options.enabledServices) && options.enabledServices.length
      ? options.enabledServices.filter(s => paidPlan.includes(s))
      : DEFAULT_SERVICES.filter(s => paidPlan.includes(s));
    enabledFeatures = mergeEnabledFeatures(enabledServices, paidPlan);
  }

  const { data: existing } = await supabaseAdmin
    .from('restaurant_subscriptions')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .maybeSingle();

  if (!existing) {
    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + 30);

    const { error: subErr } = await supabaseAdmin.from('restaurant_subscriptions').insert({
      restaurant_id: restaurantId,
      features:      paidPlan,
      status:        'trial',
      billing_cycle: 'monthly',
      base_price:    0,
      discount_pct:  0,
      final_price:   0,
      trial_ends_at: trialEnds.toISOString(),
    });
    if (subErr) {
      console.warn('[subscriptionBilling] insert failed (non-fatal):', subErr.message);
    }
  }

  await supabaseAdmin.from('restaurants')
    .update({ subscribed_features: enabledFeatures, updated_at: new Date().toISOString() })
    .eq('id', restaurantId);

  return { paidPlan, enabledFeatures };
}

module.exports = { ensureRestaurantSubscription, DEFAULT_SERVICES };
