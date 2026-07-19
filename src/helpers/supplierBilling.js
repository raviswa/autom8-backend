'use strict';

/**
 * Create supplier_subscriptions trial row (₹1000/mo, 30-day trial).
 * Called on successful supplier registration BEFORE referral credit.
 */

const { supabaseAdmin } = require('../config/supabase');

async function ensureSupplierSubscription(supplierId) {
  if (!supplierId) return null;

  const { data: existing, error: existingErr } = await supabaseAdmin
    .from('supplier_subscriptions')
    .select('id')
    .eq('supplier_id', supplierId)
    .maybeSingle();

  if (existingErr) {
    console.error('[supplierBilling] lookup failed', {
      supplier_id: supplierId,
      error: existingErr.message,
    });
    throw new Error(existingErr.message);
  }
  if (existing) return existing;

  const trialEnds = new Date();
  trialEnds.setDate(trialEnds.getDate() + 30);

  const { data, error } = await supabaseAdmin
    .from('supplier_subscriptions')
    .insert({
      supplier_id: supplierId,
      status: 'trial',
      trial_ends_at: trialEnds.toISOString(),
      base_price: 1000,
      final_price: 1000,
      billing_cycle: 'monthly',
    })
    .select()
    .single();

  if (error) {
    console.error('[supplierBilling] insert failed', {
      supplier_id: supplierId,
      error: error.message,
    });
    throw new Error(error.message);
  }

  console.log(`[supplierBilling] trial started for supplier ${supplierId} until ${trialEnds.toISOString()}`);
  return data;
}

module.exports = { ensureSupplierSubscription };
