'use strict';

/**
 * Link Autom8 Supply portal to a primary-LOB tenant (same auth / same WABA).
 */

const { isSupplyImplied, calculateMonthlyPrice } = require('./subscriptionPricing');

async function resolveSupplierByRestaurantId(supabaseAdmin, restaurantId) {
  if (!restaurantId) return null;
  const { data, error } = await supabaseAdmin
    .from('suppliers')
    .select('id, restaurant_id, auth_user_id, email, business_name, name, is_active, phone, city, address')
    .eq('restaurant_id', restaurantId)
    .maybeSingle();
  if (error) {
    console.warn('[supplyTenant] resolve by restaurant_id:', error.message);
    return null;
  }
  return data || null;
}

/**
 * Create or reactivate suppliers row for this tenant. Does not create a second
 * tenant or WhatsApp integration. Prefer leaving waba_phone_number_id null so
 * outbound uses tenant_integrations via supplyWabaCredentials.
 */
async function ensureSupplierForTenant(supabaseAdmin, {
  restaurantId,
  authUserId = null,
  email = null,
  name = null,
  businessName = null,
  phone = null,
  city = null,
  address = null,
  activate = true,
} = {}) {
  if (!restaurantId) {
    const err = new Error('restaurantId required to enable supply');
    err.status = 400;
    throw err;
  }

  const existing = await resolveSupplierByRestaurantId(supabaseAdmin, restaurantId);
  if (existing) {
    if (activate && existing.is_active === false) {
      const { data, error } = await supabaseAdmin
        .from('suppliers')
        .update({ is_active: true, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      return data;
    }
    return existing;
  }

  // Fallback: same owner/email already has a suppliers row (legacy b2b signup)
  if (authUserId || email) {
    const orParts = [];
    if (authUserId) orParts.push(`auth_user_id.eq.${authUserId}`);
    if (email) orParts.push(`email.eq.${String(email).trim().toLowerCase()}`);
    const { data: byOwner } = await supabaseAdmin
      .from('suppliers')
      .select('id, restaurant_id, is_active')
      .or(orParts.join(','))
      .maybeSingle();
    if (byOwner) {
      const { data, error } = await supabaseAdmin
        .from('suppliers')
        .update({
          restaurant_id: restaurantId,
          is_active: activate ? true : byOwner.is_active,
          updated_at: new Date().toISOString(),
        })
        .eq('id', byOwner.id)
        .select()
        .single();
      if (error) throw error;
      return data;
    }
  }

  const digits = String(phone || '').replace(/\D/g, '') || '0000000000';
  const { data: created, error: createErr } = await supabaseAdmin
    .from('suppliers')
    .insert({
      auth_user_id: authUserId || null,
      name: (name || businessName || 'Supplier').trim(),
      business_name: (businessName || name || 'Supplier').trim(),
      email: email ? String(email).trim().toLowerCase() : null,
      phone: digits,
      city: city || null,
      address: address || null,
      lob_type: 'food_service',
      restaurant_id: restaurantId,
      // Dual-LOB: do not duplicate WABA creds on suppliers — use tenant integrations.
      waba_phone: null,
      waba_phone_number_id: null,
      is_active: activate !== false,
    })
    .select()
    .single();
  if (createErr) throw createErr;
  return created;
}

async function deactivateSupplierForTenant(supabaseAdmin, restaurantId) {
  const existing = await resolveSupplierByRestaurantId(supabaseAdmin, restaurantId);
  if (!existing) return null;
  const { data, error } = await supabaseAdmin
    .from('suppliers')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Update tenant_subscriptions list price from calculateMonthlyPrice.
 * Does not change trial status; updates base_price + final_price (minus existing discount_pct if any).
 */
async function syncSubscriptionListPrice(supabaseAdmin, restaurantId, tenant) {
  if (!restaurantId || !tenant) return null;
  const listPrice = calculateMonthlyPrice(tenant);
  const { data: sub } = await supabaseAdmin
    .from('tenant_subscriptions')
    .select('id, status, discount_pct, base_price, final_price')
    .eq('restaurant_id', restaurantId)
    .maybeSingle();
  if (!sub) return null;

  // Trials keep charged amount 0 until paid — still store list price on base_price for display.
  const discountPct = Number(sub.discount_pct) || 0;
  const discounted = Math.max(0, Math.round(listPrice * (1 - discountPct / 100) * 100) / 100);
  const isTrial = String(sub.status || '') === 'trial';
  const patch = {
    base_price: listPrice,
    final_price: isTrial ? 0 : discounted,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabaseAdmin
    .from('tenant_subscriptions')
    .update(patch)
    .eq('id', sub.id)
    .select()
    .single();
  if (error) {
    console.warn('[supplyTenant] syncSubscriptionListPrice:', error.message);
    return null;
  }
  return data;
}

async function setTenantSupplyEnabled(supabaseAdmin, {
  restaurantId,
  enabled,
  authUserId = null,
  email = null,
  name = null,
  businessName = null,
  phone = null,
  city = null,
  address = null,
  tenantRow = null,
} = {}) {
  const want = !!enabled;
  const { data: tenant, error: tErr } = await supabaseAdmin
    .from('tenants')
    .select('id, lob_type, supply_enabled, name, display_name, email, contact_email, contact_phone, whatsapp_number, city, address_line1')
    .eq('id', restaurantId)
    .maybeSingle();
  if (tErr) throw tErr;
  if (!tenant) {
    const err = new Error('Restaurant not found');
    err.status = 404;
    throw err;
  }

  // Pure b2b: supply is implied — keep flag true; do not allow "disable" of primary supply-only.
  if (isSupplyImplied(tenant) && !want) {
    const err = new Error('Supply-only (b2b) accounts cannot disable supply. Change business type first.');
    err.status = 400;
    err.code = 'supply_required_for_b2b';
    throw err;
  }

  const nextEnabled = isSupplyImplied(tenant) ? true : want;
  const { data: updated, error: uErr } = await supabaseAdmin
    .from('tenants')
    .update({
      supply_enabled: nextEnabled,
      updated_at: new Date().toISOString(),
    })
    .eq('id', restaurantId)
    .select()
    .single();
  if (uErr) {
    if (/supply_enabled/i.test(uErr.message || '')) {
      const err = new Error('supply_enabled column missing — run migration 20260808_tenant_supply_enabled.sql');
      err.status = 500;
      err.code = 'migration_required';
      throw err;
    }
    throw uErr;
  }

  let supplier = null;
  if (nextEnabled) {
    supplier = await ensureSupplierForTenant(supabaseAdmin, {
      restaurantId,
      authUserId,
      email: email || tenant.contact_email || tenant.email,
      name: name || tenant.display_name || tenant.name,
      businessName: businessName || tenant.display_name || tenant.name,
      phone: phone || tenant.whatsapp_number || tenant.contact_phone,
      city: city || tenant.city,
      address: address || tenant.address_line1,
      activate: true,
    });
  } else if (!isSupplyImplied(tenant)) {
    supplier = await deactivateSupplierForTenant(supabaseAdmin, restaurantId);
  }

  const merged = { ...(tenantRow || tenant), ...updated, supply_enabled: nextEnabled };
  const subscription = await syncSubscriptionListPrice(supabaseAdmin, restaurantId, merged);

  return {
    tenant: updated,
    supplier,
    subscription,
    monthly_price: calculateMonthlyPrice(merged),
  };
}

module.exports = {
  resolveSupplierByRestaurantId,
  ensureSupplierForTenant,
  deactivateSupplierForTenant,
  syncSubscriptionListPrice,
  setTenantSupplyEnabled,
};
