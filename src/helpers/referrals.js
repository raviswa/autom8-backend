'use strict';

/**
 * Tenant referral program — tiered bonus days.
 *
 * Referrer is always a tenant. Referred side is polymorphic (tenant | supplier).
 * Crediting always extends the REFERRER tenant's subscription (suppliers have
 * no tenant_subscriptions row).
 *
 * Cumulative pool (same for tier selection):
 *   count(tenants where first_message_at is not null) + count(suppliers)
 */

const { supabaseAdmin } = require('../config/supabase');

function summarizeError(error) {
  if (!error) return null;
  return {
    message: error.message || null,
    details: error.details || null,
    hint: error.hint || null,
    code: error.code || null,
  };
}

function logReferralError(scope, error, context = {}) {
  console.error(`[referrals] ${scope} failed`, {
    ...context,
    error: summarizeError(error),
  });
}

/**
 * Live customer count used to pick the active bonus tier.
 * Suppliers count toward the SAME pool as activated tenants.
 */
async function getCumulativeCustomerCount() {
  const [tenantsRes, suppliersRes] = await Promise.all([
    supabaseAdmin
      .from('tenants')
      .select('id', { count: 'exact', head: true })
      .not('first_message_at', 'is', null),
    supabaseAdmin
      .from('suppliers')
      .select('id', { count: 'exact', head: true }),
  ]);

  if (tenantsRes.error) {
    logReferralError('getCumulativeCustomerCount.tenants', tenantsRes.error);
    throw new Error(tenantsRes.error.message);
  }
  if (suppliersRes.error) {
    logReferralError('getCumulativeCustomerCount.suppliers', suppliersRes.error);
    throw new Error(suppliersRes.error.message);
  }

  return (tenantsRes.count || 0) + (suppliersRes.count || 0);
}

async function listTiers() {
  const { data, error } = await supabaseAdmin
    .from('referral_program_tiers')
    .select('id, tier_order, min_cumulative_count, bonus_days, note, created_at')
    .order('tier_order', { ascending: true });

  if (error) {
    logReferralError('listTiers', error);
    throw new Error(error.message);
  }
  return data || [];
}

/**
 * Active tier = highest min_cumulative_count that is <= cumulative count.
 * Returns { bonusDays, tier, cumulativeCount, tiers }.
 */
async function getCurrentBonusDays() {
  const [cumulativeCount, tiers] = await Promise.all([
    getCumulativeCustomerCount(),
    listTiers(),
  ]);

  if (!tiers.length) {
    throw new Error('No referral_program_tiers rows configured');
  }

  // Highest min_cumulative_count that is still <= live count.
  const active = tiers
    .filter((t) => t.min_cumulative_count <= cumulativeCount)
    .sort((a, b) => b.min_cumulative_count - a.min_cumulative_count)[0]
    || [...tiers].sort((a, b) => a.min_cumulative_count - b.min_cumulative_count)[0];

  return {
    bonusDays: active.bonus_days,
    tier: active,
    cumulativeCount,
    tiers,
  };
}

async function assertReferredExists(referredType, referredId) {
  if (referredType === 'tenant') {
    const { data, error } = await supabaseAdmin
      .from('tenants')
      .select('id, name, contact_email, email')
      .eq('id', referredId)
      .maybeSingle();
    if (error) {
      logReferralError('assertReferredExists.tenant', error, { referredId });
      throw new Error(error.message);
    }
    if (!data) {
      const err = new Error(`No tenant found with id ${referredId}`);
      err.code = 'referred_not_found';
      throw err;
    }
    return { id: data.id, name: data.name, email: data.contact_email || data.email || null };
  }

  if (referredType === 'supplier') {
    const { data, error } = await supabaseAdmin
      .from('suppliers')
      .select('id, name, business_name, email')
      .eq('id', referredId)
      .maybeSingle();
    if (error) {
      logReferralError('assertReferredExists.supplier', error, { referredId });
      throw new Error(error.message);
    }
    if (!data) {
      const err = new Error(`No supplier found with id ${referredId}`);
      err.code = 'referred_not_found';
      throw err;
    }
    return {
      id: data.id,
      name: data.business_name || data.name,
      email: data.email || null,
    };
  }

  const err = new Error("referred_type must be 'tenant' or 'supplier'");
  err.code = 'invalid_referred_type';
  throw err;
}

async function createReferral({
  referrerRestaurantId,
  referredType,
  referredId,
  createdBy = null,
}) {
  if (!referrerRestaurantId) {
    const err = new Error('referrer_restaurant_id is required');
    err.code = 'validation';
    throw err;
  }
  if (!referredId) {
    const err = new Error('referred_id is required');
    err.code = 'validation';
    throw err;
  }
  if (referredType !== 'tenant' && referredType !== 'supplier') {
    const err = new Error("referred_type must be 'tenant' or 'supplier'");
    err.code = 'invalid_referred_type';
    throw err;
  }
  if (referredType === 'tenant' && referrerRestaurantId === referredId) {
    const err = new Error('A restaurant cannot refer itself');
    err.code = 'validation';
    throw err;
  }

  const { data: referrer, error: referrerErr } = await supabaseAdmin
    .from('tenants')
    .select('id, name')
    .eq('id', referrerRestaurantId)
    .maybeSingle();
  if (referrerErr) {
    logReferralError('createReferral.referrer', referrerErr, { referrerRestaurantId });
    throw new Error(referrerErr.message);
  }
  if (!referrer) {
    const err = new Error(`No referrer tenant found with id ${referrerRestaurantId}`);
    err.code = 'referrer_not_found';
    throw err;
  }

  await assertReferredExists(referredType, referredId);

  const { data: existing } = await supabaseAdmin
    .from('tenant_referrals')
    .select('id, status')
    .eq('referred_type', referredType)
    .eq('referred_id', referredId)
    .maybeSingle();

  if (existing) {
    const err = new Error(
      `A referral already exists for this ${referredType} (status=${existing.status})`,
    );
    err.code = 'duplicate_referral';
    err.existingId = existing.id;
    throw err;
  }

  const { bonusDays, tier } = await getCurrentBonusDays();

  const { data: row, error: insertErr } = await supabaseAdmin
    .from('tenant_referrals')
    .insert({
      referrer_restaurant_id: referrerRestaurantId,
      referred_type: referredType,
      referred_id: referredId,
      bonus_days_snapshot: bonusDays,
      status: 'pending',
      created_by: createdBy || null,
    })
    .select()
    .single();

  if (insertErr) {
    if (insertErr.code === '23505') {
      const err = new Error(`A referral already exists for this ${referredType}`);
      err.code = 'duplicate_referral';
      throw err;
    }
    logReferralError('createReferral.insert', insertErr, {
      referrerRestaurantId,
      referredType,
      referredId,
    });
    throw new Error(insertErr.message);
  }

  // Suppliers activate at registration. If the referral is linked after the
  // supplier already exists, credit immediately so sales-led linking works.
  let creditResult = null;
  if (referredType === 'supplier') {
    creditResult = await creditReferralIfPending('supplier', referredId);
  }

  return { referral: row, tier, creditResult };
}

/**
 * Credit a pending referral for the given referred party.
 * DB work runs in one Postgres transaction via credit_referral_if_pending RPC.
 * Email is sent only after a successful commit.
 */
async function creditReferralIfPending(referredType, referredId) {
  if (!referredType || !referredId) {
    return { credited: false, reason: 'invalid_args' };
  }

  const { data, error } = await supabaseAdmin.rpc('credit_referral_if_pending', {
    p_referred_type: referredType,
    p_referred_id: referredId,
  });

  if (error) {
    logReferralError('creditReferralIfPending.rpc', error, { referredType, referredId });
    throw new Error(error.message);
  }

  const result = data && typeof data === 'object' ? data : { credited: false, reason: 'empty_rpc' };

  if (!result.credited) {
    return result;
  }

  // Post-commit side effects (email) — never roll back the credit if mail fails.
  try {
    await sendReferralCreditedEmail(result, referredType, referredId);
  } catch (mailErr) {
    console.error('[referrals] referralCredited email failed after successful credit', {
      referredType,
      referredId,
      referral_id: result.referral_id,
      error: mailErr.message,
    });
  }

  return result;
}

async function sendReferralCreditedEmail(creditResult, referredType, referredId) {
  const { sendEmail } = require('../config/mailer');
  const { referralCredited } = require('./emailTemplates');

  const referrerId = creditResult.referrer_restaurant_id;
  const { data: referrer } = await supabaseAdmin
    .from('tenants')
    .select('id, name, contact_email, email')
    .eq('id', referrerId)
    .maybeSingle();

  const to = referrer?.contact_email || referrer?.email;
  if (!to) {
    console.warn('[referrals] Skipping referralCredited email — no contact_email/email on referrer', {
      referrerId,
    });
    return;
  }

  let referredName = referredId;
  try {
    const referred = await assertReferredExists(referredType, referredId);
    referredName = referred.name || referredId;
  } catch (_) {}

  const tiers = await listTiers();
  const tier =
    tiers.find((t) => t.bonus_days === creditResult.bonus_days)
    || null;

  const { subject, html, text } = referralCredited({
    tenant: referrer,
    bonusDays: creditResult.bonus_days,
    newExpiryDate: creditResult.period_end,
    referredName,
    tier,
  });

  await sendEmail({ to, subject, html, text });
}

/**
 * Idempotent: set tenants.first_message_at once, then credit a pending tenant referral.
 * Returns { stamped, creditResult }.
 */
async function markFirstMessageAndCreditReferral(restaurantId) {
  if (!restaurantId) {
    return { stamped: false, creditResult: null };
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error } = await supabaseAdmin
    .from('tenants')
    .update({ first_message_at: nowIso })
    .eq('id', restaurantId)
    .is('first_message_at', null)
    .select('id, first_message_at')
    .maybeSingle();

  if (error) {
    logReferralError('markFirstMessageAndCreditReferral.update', error, { restaurantId });
    throw new Error(error.message);
  }

  if (!updated) {
    return { stamped: false, creditResult: null };
  }

  console.log(`[referrals] first_message_at set for tenant ${restaurantId}`);

  const creditResult = await creditReferralIfPending('tenant', restaurantId);
  return { stamped: true, creditResult };
}

async function listReferrals() {
  const { data: rows, error } = await supabaseAdmin
    .from('tenant_referrals')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    logReferralError('listReferrals', error);
    throw new Error(error.message);
  }

  const list = rows || [];
  if (!list.length) return [];

  const referrerIds = [...new Set(list.map((r) => r.referrer_restaurant_id))];
  const tenantReferredIds = [
    ...new Set(list.filter((r) => r.referred_type === 'tenant').map((r) => r.referred_id)),
  ];
  const supplierReferredIds = [
    ...new Set(list.filter((r) => r.referred_type === 'supplier').map((r) => r.referred_id)),
  ];

  const [referrersRes, tenantsRes, suppliersRes] = await Promise.all([
    referrerIds.length
      ? supabaseAdmin.from('tenants').select('id, name').in('id', referrerIds)
      : Promise.resolve({ data: [], error: null }),
    tenantReferredIds.length
      ? supabaseAdmin.from('tenants').select('id, name').in('id', tenantReferredIds)
      : Promise.resolve({ data: [], error: null }),
    supplierReferredIds.length
      ? supabaseAdmin.from('suppliers').select('id, name, business_name').in('id', supplierReferredIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (referrersRes.error) logReferralError('listReferrals.referrers', referrersRes.error);
  if (tenantsRes.error) logReferralError('listReferrals.tenants', tenantsRes.error);
  if (suppliersRes.error) logReferralError('listReferrals.suppliers', suppliersRes.error);

  const referrerName = Object.fromEntries((referrersRes.data || []).map((t) => [t.id, t.name]));
  const tenantName = Object.fromEntries((tenantsRes.data || []).map((t) => [t.id, t.name]));
  const supplierName = Object.fromEntries(
    (suppliersRes.data || []).map((s) => [s.id, s.business_name || s.name]),
  );

  return list.map((r) => ({
    ...r,
    referrer_name: referrerName[r.referrer_restaurant_id] || null,
    referred_name:
      r.referred_type === 'tenant'
        ? (tenantName[r.referred_id] || null)
        : (supplierName[r.referred_id] || null),
  }));
}

async function getTierStatus() {
  const { bonusDays, tier, cumulativeCount, tiers } = await getCurrentBonusDays();
  const sorted = [...tiers].sort((a, b) => a.min_cumulative_count - b.min_cumulative_count);
  const next = sorted.find((t) => t.min_cumulative_count > cumulativeCount) || null;
  return {
    cumulative_count: cumulativeCount,
    active_tier: tier,
    active_bonus_days: bonusDays,
    next_tier: next,
    signups_until_next: next ? next.min_cumulative_count - cumulativeCount : null,
    tiers: sorted,
  };
}

module.exports = {
  getCumulativeCustomerCount,
  getCurrentBonusDays,
  createReferral,
  creditReferralIfPending,
  markFirstMessageAndCreditReferral,
  listReferrals,
  listTiers,
  getTierStatus,
};
