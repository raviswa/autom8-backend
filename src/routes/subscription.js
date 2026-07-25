// src/routes/subscription.js
// ============================================================================
// Subscription / feature-flag + billing endpoints
//
// GET  /api/subscription              — plan, features, billing summary
// GET  /api/subscription/brand        — per-outlet list for brand_owner
// POST /api/subscription/checkout     — PhonePe pay page (single outlet)
// POST /api/subscription/apply-offer  — validate promo vs ₹1000 base
// POST /api/subscription/phonepe/callback — PhonePe S2S callback
// GET  /api/subscription/phonepe/status/:txnId — confirm after redirect
// PUT  /api/subscription/paid-features — ops (KDS secret)
// POST /api/subscription/offers       — ops create offer (KDS secret)
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
const {
  isSubscriptionSoftLocked,
  getCycleAnchor,
  daysRelativeToAnchor,
  GRACE_PERIOD_DAYS,
} = require('../helpers/subscriptionAccess');
const {
  MONTHLY_PRICE_INR,
  phonepeConfigured,
  applyOfferDiscount,
  createSubscriptionPayPage,
  checkPaymentStatus,
  isPhonePePaymentSuccess,
} = require('../helpers/phonepeSubscription');
const {
  getPhonePeGateway,
  upsertPhonePeGateway,
} = require('../helpers/tenantPaymentGateways');

const BRAND_ROLES = ['brand_owner', 'brand_manager'];

async function loadReferralBonusDays(restaurantId) {
  try {
    const { data: rows } = await supabaseAdmin
      .from('tenant_referrals')
      .select('bonus_days_snapshot, status')
      .eq('referrer_restaurant_id', restaurantId)
      .eq('status', 'credited');
    const days = (rows || []).reduce((sum, r) => sum + (Number(r.bonus_days_snapshot) || 0), 0);
    return days;
  } catch {
    return 0;
  }
}

async function loadOfferByCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;
  const { data } = await supabaseAdmin
    .from('subscription_offers')
    .select('*')
    .ilike('code', normalized)
    .eq('is_active', true)
    .maybeSingle();
  if (!data) return null;
  const now = Date.now();
  if (data.valid_from && new Date(data.valid_from).getTime() > now) return null;
  if (data.valid_until && new Date(data.valid_until).getTime() < now) return null;
  if (data.max_redemptions != null && data.redemption_count >= data.max_redemptions) return null;
  return data;
}

function computeBillingFlags(sub) {
  const softLocked = isSubscriptionSoftLocked(sub);
  const anchor = getCycleAnchor(sub);
  const relative = daysRelativeToAnchor(anchor);
  let daysUntilDue = null;
  if (relative != null) daysUntilDue = -relative;
  return {
    soft_locked: softLocked,
    grace_period_days: GRACE_PERIOD_DAYS,
    days_until_due: daysUntilDue,
    cycle_anchor: anchor,
  };
}

async function markSubscriptionPaid({ restaurantId, paymentRowId, amountInr, merchantTxnId }) {
  const now = new Date();
  const renews = new Date(now);
  renews.setDate(renews.getDate() + 30);

  await supabaseAdmin
    .from('tenant_subscription_payments')
    .update({
      status: 'completed',
      notes: `PhonePe paid ${merchantTxnId}`,
    })
    .eq('id', paymentRowId);

  const { data: sub } = await supabaseAdmin
    .from('tenant_subscriptions')
    .select('id, trial_ends_at, renews_at, status')
    .eq('restaurant_id', restaurantId)
    .maybeSingle();

  if (sub) {
    await supabaseAdmin
      .from('tenant_subscriptions')
      .update({
        status: 'active',
        renews_at: renews.toISOString(),
        final_price: amountInr,
        base_price: MONTHLY_PRICE_INR,
        billing_cycle: 'monthly',
        updated_at: now.toISOString(),
      })
      .eq('restaurant_id', restaurantId);
  } else {
    await supabaseAdmin.from('tenant_subscriptions').insert({
      restaurant_id: restaurantId,
      status: 'active',
      billing_cycle: 'monthly',
      base_price: MONTHLY_PRICE_INR,
      discount_pct: 0,
      final_price: amountInr,
      renews_at: renews.toISOString(),
      features: ALL_FEATURES,
    });
  }
}

async function assertOutletAccess(req, restaurantId) {
  if (!restaurantId) {
    const err = new Error('restaurant_id is required');
    err.status = 400;
    throw err;
  }
  if (req.scope === 'outlet' && req.restaurant_id === restaurantId) return;
  if (BRAND_ROLES.includes(req.user_role) && req.brand_id) {
    const { data: outlet } = await supabaseAdmin
      .from('tenants')
      .select('id')
      .eq('id', restaurantId)
      .eq('brand_id', req.brand_id)
      .maybeSingle();
    if (outlet?.id) return;
  }
  if (req.user_role === 'owner' && req.restaurant_id === restaurantId) return;
  const err = new Error('Not authorized for this outlet');
  err.status = 403;
  throw err;
}

// ── GET /api/subscription ─────────────────────────────────────────────────────

router.get('/', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!req.restaurant_id) {
      return res.status(400).json({
        error: 'No outlet context — use /api/subscription/brand or pass x-restaurant-id',
      });
    }

    const { data: restaurant } = await supabaseAdmin
      .from('tenants')
      .select('subscribed_features, name, display_name, whatsapp_needs_existing_pin')
      .eq('id', req.restaurant_id)
      .single();

    const { data: sub } = await supabaseAdmin
      .from('tenant_subscriptions')
      .select('plan, status, trial_ends_at, renews_at, base_price, final_price, billing_cycle, features, applied_offer_code')
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
    const billing     = computeBillingFlags(sub);
    const referralBonusDays = await loadReferralBonusDays(req.restaurant_id);
    const phonepeGateway = await getPhonePeGateway(req.restaurant_id).catch(() => null);

    const { data: payments } = await supabaseAdmin
      .from('tenant_subscription_payments')
      .select('id, amount, currency, source, status, notes, payment_link_url, offer_code, external_reference, created_at, period_start, period_end')
      .eq('restaurant_id', req.restaurant_id)
      .order('created_at', { ascending: false })
      .limit(20);

    const basePrice = MONTHLY_PRICE_INR;
    const appliedOffer = sub?.applied_offer_code
      ? await loadOfferByCode(sub.applied_offer_code)
      : null;
    const priced = applyOfferDiscount(basePrice, appliedOffer);

    res.json({
      success:          true,
      plan:             sub?.billing_cycle === 'annual' ? `${plan}_annual` : plan,
      status,
      is_active:        isActive,
      trial_ends_at:    sub?.trial_ends_at   ?? null,
      renews_at:        sub?.renews_at       ?? null,
      price:            priced.amountInr,
      base_price:       basePrice,
      currency:         'INR',
      billing_cycle:    sub?.billing_cycle   ?? 'monthly',
      paid_features:    paidFeatures,
      enabled_features: enabledFeatures,
      enabled_services: enabledServices,
      features:         enabledFeatures,
      subscribed_features: enabledFeatures,
      soft_locked:      billing.soft_locked,
      grace_period_days: billing.grace_period_days,
      days_until_due:   billing.days_until_due,
      referral_bonus_days: referralBonusDays,
      applied_offer_code: sub?.applied_offer_code || null,
      phonepe_configured: phonepeConfigured(),
      phonepe_merchant: phonepeGateway,
      payments: payments || [],
      business_name: restaurant?.display_name || restaurant?.name || null,
      whatsapp_needs_existing_pin: Boolean(restaurant?.whatsapp_needs_existing_pin),
    });
  } catch (err) {
    console.error('[subscription]', err.message);
    res.json({
      success:          true,
      plan:             'trial',
      status:           'trial',
      is_active:        true,
      soft_locked:      false,
      paid_features:    ALL_FEATURES,
      enabled_features: ALL_FEATURES,
      enabled_services: ['dine_in', 'takeaway', 'delivery', 'reserve_table'],
      features:         ALL_FEATURES,
      subscribed_features: ALL_FEATURES,
      base_price:       MONTHLY_PRICE_INR,
      price:            MONTHLY_PRICE_INR,
      currency:         'INR',
    });
  }
});

// ── GET /api/subscription/brand — Screen B2 ───────────────────────────────────

router.get('/brand', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!BRAND_ROLES.includes(req.user_role) || !req.brand_id) {
      return res.status(403).json({ error: 'Brand billing is only for brand owners/managers' });
    }

    const { data: outlets } = await supabaseAdmin
      .from('tenants')
      .select('id, name, display_name, whatsapp_number, is_active')
      .eq('brand_id', req.brand_id)
      .eq('is_active', true)
      .order('name', { ascending: true });

    const list = [];
    for (const o of outlets || []) {
      const { data: sub } = await supabaseAdmin
        .from('tenant_subscriptions')
        .select('status, trial_ends_at, renews_at, final_price')
        .eq('restaurant_id', o.id)
        .maybeSingle();
      const billing = computeBillingFlags(sub);
      list.push({
        restaurant_id: o.id,
        name: o.display_name || o.name,
        whatsapp_number: o.whatsapp_number || null,
        status: sub?.status || 'trial',
        trial_ends_at: sub?.trial_ends_at || null,
        renews_at: sub?.renews_at || null,
        price: MONTHLY_PRICE_INR,
        soft_locked: billing.soft_locked,
        days_until_due: billing.days_until_due,
        phonepe_merchant: await getPhonePeGateway(o.id).catch(() => null),
      });
    }

    const total = list.length * MONTHLY_PRICE_INR;
    res.json({
      success: true,
      brand_id: req.brand_id,
      outlets: list,
      outlet_count: list.length,
      total_monthly: total,
      currency: 'INR',
      per_outlet_price: MONTHLY_PRICE_INR,
      phonepe_configured: phonepeConfigured(),
    });
  } catch (err) {
    console.error('[subscription/brand]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET/PUT PhonePe merchant registry (partnership / audit — no secrets) ─────

router.get('/payment-gateway', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const restaurantId = req.query.restaurant_id || req.restaurant_id;
    await assertOutletAccess(req, restaurantId);
    const gateway = await getPhonePeGateway(restaurantId);
    res.json({ success: true, gateway });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

router.put('/payment-gateway', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const restaurantId = req.body.restaurant_id || req.restaurant_id;
    await assertOutletAccess(req, restaurantId);
    // Owners may set MID + name + referral code; status stays pending unless ops elevates
    const body = {
      merchant_id: req.body.merchant_id,
      merchant_name: req.body.merchant_name,
      partner_referral_code: req.body.partner_referral_code,
    };
    // Only KDS/ops path below sets status=live; owners default to pending if new
    if (req.body.status && ['owner', 'brand_owner', 'brand_manager'].includes(req.user_role)) {
      // Allow owner to mark inactive; live/kyc still via ops
      if (req.body.status === 'inactive' || req.body.status === 'pending') {
        body.status = req.body.status;
      }
    }
    const gateway = await upsertPhonePeGateway(restaurantId, body);
    res.json({ success: true, gateway });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

/** Ops: set status (live / kyc_failed) for partnership tracking */
router.put('/payment-gateway/status', requireKdsSecret, async (req, res) => {
  try {
    const { restaurant_id, status, merchant_id, merchant_name, partner_referral_code } = req.body || {};
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id required' });
    const existing = await getPhonePeGateway(restaurant_id);
    const gateway = await upsertPhonePeGateway(restaurant_id, {
      merchant_id: merchant_id || existing?.merchant_id,
      merchant_name: merchant_name !== undefined ? merchant_name : existing?.merchant_name,
      partner_referral_code: partner_referral_code !== undefined
        ? partner_referral_code
        : existing?.partner_referral_code,
      status,
    });
    res.json({ success: true, gateway });
  } catch (err) {
    const statusCode = err.status || 500;
    res.status(statusCode).json({ error: err.message });
  }
});

/** Ops: list PhonePe MIDs for partnership reporting */
router.get('/payment-gateways', requireKdsSecret, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tenant_payment_gateways')
      .select('id, restaurant_id, provider, merchant_id, merchant_name, partner_referral_code, status, linked_at, is_active, created_at, updated_at')
      .eq('provider', 'phonepe')
      .order('updated_at', { ascending: false })
      .limit(Math.min(parseInt(req.query.limit, 10) || 500, 2000));
    if (error) throw error;
    res.json({ success: true, gateways: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/subscription/apply-offer ────────────────────────────────────────

router.post('/apply-offer', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const restaurantId = req.body.restaurant_id || req.restaurant_id;
    await assertOutletAccess(req, restaurantId);

    const offer = await loadOfferByCode(req.body.code);
    if (!offer) {
      return res.status(404).json({ error: 'Offer code is invalid or expired' });
    }

    const priced = applyOfferDiscount(MONTHLY_PRICE_INR, offer);
    await supabaseAdmin
      .from('tenant_subscriptions')
      .update({
        applied_offer_code: offer.code,
        final_price: priced.amountInr,
        updated_at: new Date().toISOString(),
      })
      .eq('restaurant_id', restaurantId);

    res.json({
      success: true,
      code: offer.code,
      discount_type: offer.discount_type,
      discount_value: offer.discount_value,
      base_price: MONTHLY_PRICE_INR,
      final_price: priced.amountInr,
      discount_inr: priced.discountInr,
      currency: 'INR',
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// ── POST /api/subscription/checkout — PhonePe (single outlet) ─────────────────

router.post('/checkout', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const restaurantId = req.body.restaurant_id || req.restaurant_id;
    await assertOutletAccess(req, restaurantId);

    if (!phonepeConfigured()) {
      return res.status(503).json({
        error: 'PhonePe is not configured yet. Contact Autom8 support to enable billing.',
      });
    }

    const { data: sub } = await supabaseAdmin
      .from('tenant_subscriptions')
      .select('applied_offer_code, final_price')
      .eq('restaurant_id', restaurantId)
      .maybeSingle();

    const offer = sub?.applied_offer_code
      ? await loadOfferByCode(sub.applied_offer_code)
      : null;
    const priced = applyOfferDiscount(MONTHLY_PRICE_INR, offer);

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + 30);

    const pay = await createSubscriptionPayPage({
      restaurantId,
      amountInr: priced.amountInr,
    });

    const { data: paymentRow, error: payErr } = await supabaseAdmin
      .from('tenant_subscription_payments')
      .insert({
        restaurant_id: restaurantId,
        amount: priced.amountInr,
        currency: 'INR',
        source: 'phonepe',
        status: 'pending',
        payment_link_url: pay.redirectUrl,
        external_reference: pay.merchantTransactionId,
        offer_code: offer?.code || null,
        period_start: now.toISOString(),
        period_end: periodEnd.toISOString(),
        notes: 'PhonePe checkout created',
      })
      .select('id')
      .single();

    if (payErr) {
      console.error('[subscription/checkout] payment insert failed:', payErr.message);
      return res.status(500).json({ error: 'Could not create payment record' });
    }

    if (offer?.id) {
      await supabaseAdmin
        .from('subscription_offers')
        .update({ redemption_count: (offer.redemption_count || 0) + 1 })
        .eq('id', offer.id);
    }

    res.json({
      success: true,
      payment_id: paymentRow.id,
      redirect_url: pay.redirectUrl,
      amount: priced.amountInr,
      currency: 'INR',
      merchant_transaction_id: pay.merchantTransactionId,
    });
  } catch (err) {
    console.error('[subscription/checkout]', err.message, err.phonepe || '');
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Checkout failed' });
  }
});

// ── PhonePe S2S callback ──────────────────────────────────────────────────────

router.post('/phonepe/callback', async (req, res) => {
  try {
    const body = req.body || {};
    const encoded = body.response || body;
    let payload = body;
    if (typeof encoded === 'string') {
      try {
        payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      } catch {
        payload = body;
      }
    }

    const txnId =
      payload?.data?.merchantTransactionId
      || payload?.merchantTransactionId
      || payload?.data?.transactionId
      || null;

    if (!txnId) {
      console.warn('[subscription/phonepe/callback] missing txn id', payload);
      return res.status(200).json({ success: true });
    }

    const statusPayload = await checkPaymentStatus(txnId);
    if (!isPhonePePaymentSuccess(statusPayload) && !isPhonePePaymentSuccess(payload)) {
      console.warn('[subscription/phonepe/callback] not success yet', txnId, statusPayload?.code);
      return res.status(200).json({ success: true });
    }

    const { data: payment } = await supabaseAdmin
      .from('tenant_subscription_payments')
      .select('id, restaurant_id, amount, status')
      .eq('external_reference', txnId)
      .maybeSingle();

    if (!payment) {
      console.warn('[subscription/phonepe/callback] unknown payment', txnId);
      return res.status(200).json({ success: true });
    }
    if (payment.status === 'completed') {
      return res.status(200).json({ success: true });
    }

    await markSubscriptionPaid({
      restaurantId: payment.restaurant_id,
      paymentRowId: payment.id,
      amountInr: payment.amount,
      merchantTxnId: txnId,
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[subscription/phonepe/callback]', err.message);
    res.status(200).json({ success: true });
  }
});

// ── GET status after browser return ───────────────────────────────────────────

router.get('/phonepe/status/:txnId', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const txnId = req.params.txnId;
    const { data: payment } = await supabaseAdmin
      .from('tenant_subscription_payments')
      .select('id, restaurant_id, amount, status, external_reference')
      .eq('external_reference', txnId)
      .maybeSingle();

    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    await assertOutletAccess(req, payment.restaurant_id);

    if (payment.status !== 'completed') {
      const statusPayload = await checkPaymentStatus(txnId);
      if (isPhonePePaymentSuccess(statusPayload)) {
        await markSubscriptionPaid({
          restaurantId: payment.restaurant_id,
          paymentRowId: payment.id,
          amountInr: payment.amount,
          merchantTxnId: txnId,
        });
        payment.status = 'completed';
      }
    }

    res.json({
      success: true,
      status: payment.status,
      merchant_transaction_id: txnId,
      amount: payment.amount,
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// ── PUT /api/subscription/paid-features ───────────────────────────────────────

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
      .from('tenants')
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
      .from('tenant_subscriptions')
      .select('id')
      .eq('restaurant_id', restaurant_id)
      .maybeSingle();

    if (sub) {
      await supabaseAdmin
        .from('tenant_subscriptions')
        .update({ features: paid_features, updated_at: new Date().toISOString() })
        .eq('restaurant_id', restaurant_id);
    } else {
      const trialEnds = new Date();
      trialEnds.setDate(trialEnds.getDate() + 30);
      await supabaseAdmin.from('tenant_subscriptions').insert({
        restaurant_id,
        features:      paid_features,
        status:        'active',
        billing_cycle: 'monthly',
        base_price:    MONTHLY_PRICE_INR,
        discount_pct:  0,
        final_price:   MONTHLY_PRICE_INR,
        trial_ends_at: trialEnds.toISOString(),
      });
    }

    await supabaseAdmin
      .from('tenants')
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

// ── POST /api/subscription/offers — ops create promo ──────────────────────────

router.post('/offers', requireKdsSecret, async (req, res) => {
  try {
    const {
      code,
      discount_type,
      discount_value,
      applies_to_lob,
      valid_from,
      valid_until,
      max_redemptions,
    } = req.body || {};

    if (!code || !discount_type || discount_value == null) {
      return res.status(400).json({ error: 'code, discount_type, discount_value required' });
    }
    if (!['percent', 'flat'].includes(discount_type)) {
      return res.status(400).json({ error: 'discount_type must be percent or flat' });
    }

    const { data, error } = await supabaseAdmin
      .from('subscription_offers')
      .insert({
        code: String(code).trim().toUpperCase(),
        discount_type,
        discount_value: Number(discount_value),
        applies_to_lob: applies_to_lob || null,
        valid_from: valid_from || null,
        valid_until: valid_until || null,
        max_redemptions: max_redemptions ?? null,
        is_active: true,
      })
      .select('*')
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ success: true, offer: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
