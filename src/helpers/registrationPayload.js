// src/helpers/registrationPayload.js
// Build tenants insert + feature flags from self-service registration body.

'use strict';

const { DEFAULT_SERVICES } = require('./subscriptionBilling');
const {
  ORDER_SERVICES,
  mergeEnabledFeatures,
  ALL_FEATURES,
} = require('./subscriptionFeatures');
const { resolveBusinessTaxonomy } = require('../config/lobTaxonomy');

function truthy(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/** Map form fulfillment toggles → subscribed_features list. */
function featuresFromFulfillment(body = {}) {
  const selected = ['token_management'];
  if (truthy(body.dine_in)) selected.push('dine_in');
  // Packaged LOBs use store_pickup / wholesale in the registration UI
  if (truthy(body.takeaway) || truthy(body.store_pickup)) selected.push('takeaway');
  if (
    truthy(body.door_delivery)
    || truthy(body.delivery)
    || truthy(body.wholesale)
  ) selected.push('delivery');
  if (truthy(body.table_reservation) || truthy(body.reserve_table)) selected.push('reserve_table');

  // If merchant picked nothing, keep platform defaults
  if (selected.length === 1) {
    return mergeEnabledFeatures(DEFAULT_SERVICES, ALL_FEATURES);
  }
  return mergeEnabledFeatures(
    selected.filter((f) => f === 'token_management' || ORDER_SERVICES.includes(f) || f === 'reserve_table'),
    ALL_FEATURES,
  );
}

function buildOpeningHours(body = {}) {
  const hours = {};
  if (truthy(body.has_lunch) || body.lunch_start || body.lunch_end) {
    hours.lunch_start = body.lunch_start || '12:00';
    hours.lunch_end = body.lunch_end || '15:00';
  }
  if (truthy(body.has_dinner) || body.dinner_start || body.dinner_end) {
    hours.dinner_start = body.dinner_start || '19:00';
    hours.dinner_end = body.dinner_end || '23:00';
  }
  // Explicit off
  if (body.has_lunch === false) {
    delete hours.lunch_start;
    delete hours.lunch_end;
  }
  if (body.has_dinner === false) {
    delete hours.dinner_start;
    delete hours.dinner_end;
  }
  return Object.keys(hours).length ? hours : null;
}

/**
 * Build tenants insert object from registration request fields.
 * Only includes columns that exist on tenants (safe extras ignored by caller if needed).
 */
function buildTenantInsertFields(opts) {
  const {
    name,
    email,
    phone = null,
    contact_phone = null,
    whatsapp_number = null,
    waba_id = null,
    timezone = 'Asia/Kolkata',
    dining_duration_minutes = 90,
    payment_mode = 'prepay',
    manager_phone = null,
    meta_catalog_id = null,
    lob_type = 'restaurant',
    supply_enabled = false,
    business_family = null,
    business_vertical = null,
    business_vertical_other = null,
    display_name = null,
    city = null,
    country_code = null,
    currency_code = null,
    address_line1 = null,
    kitchen_workflow = null,
    cuisine_type = null,
    cuisines = null,
    categories = null,
    slug = null,
    body = {},
  } = opts;

  const cuisine = cuisine_type
    || (Array.isArray(cuisines) && cuisines.length ? cuisines.join(', ') : null)
    || (Array.isArray(categories) && categories.length ? categories.join(', ') : null)
    || null;

  const opening_hours = buildOpeningHours(body) || {};
  if (currency_code || body.currency) {
    opening_hours.currency = currency_code || body.currency;
  }
  const subscribed_features = Array.isArray(body.paid_features) && body.paid_features.length
    ? body.paid_features
    : featuresFromFulfillment(body);

  const row = {
    name: name.trim(),
    email: email.trim().toLowerCase(),
    phone: phone || contact_phone || null,
    contact_phone: contact_phone || phone || null,
    whatsapp_number: whatsapp_number || null,
    waba_id: waba_id || null,
    timezone: timezone || 'Asia/Kolkata',
    dining_duration_minutes: dining_duration_minutes || 90,
    payment_mode: payment_mode || 'prepay',
    manager_phone: manager_phone || phone || null,
    meta_catalog_id: meta_catalog_id || null,
    lob_type: lob_type || 'restaurant',
    supply_enabled: (() => {
      const lob = String(lob_type || '').toLowerCase();
      if (lob === 'b2b' || lob === 'supply' || lob === 'b2b_supply') return true;
      return supply_enabled === true || supply_enabled === 'true' || supply_enabled === 1;
    })(),
    display_name: (display_name || name || '').trim() || null,
    city: city || null,
    country: country_code || body.country || null,
    address_line1: address_line1 || null,
    cuisine_type: cuisine,
    opening_hours: Object.keys(opening_hours).length ? opening_hours : null,
    subscribed_features,
    is_active: true,
  };

  if (lob_type === 'restaurant' && kitchen_workflow) {
    row.kitchen_workflow = kitchen_workflow;
  }

  // Brochure taxonomy — labels only; engine behaviour still keys off lob_type.
  const taxonomy = resolveBusinessTaxonomy({
    business_family,
    business_vertical,
    business_vertical_other,
    lob_type,
  });
  if (taxonomy.business_family) row.business_family = taxonomy.business_family;
  if (taxonomy.business_vertical) row.business_vertical = taxonomy.business_vertical;
  if (taxonomy.business_vertical_other) {
    row.business_vertical_other = taxonomy.business_vertical_other.slice(0, 160);
  }

  // Prefer tenants.slug (add_tenant_slug migration); short_code as legacy fallback
  if (slug) {
    const s = String(slug).trim().toLowerCase().slice(0, 64) || null;
    row.slug = s;
    row.short_code = s;
  }

  // Meta utility disclosure + optional platform charge (defaults: charge off)
  const { META_UTILITY_DISCLOSURE_VERSION } = require('./registrationGuards');
  row.platform_charge_enabled = truthy(body.platform_charge_enabled);
  const conv = Number(body.platform_charge_conversation);
  const perOrder = Number(body.platform_charge_per_order);
  row.platform_charge_conversation = Number.isFinite(conv) && conv >= 0 ? conv : 1.00;
  row.platform_charge_per_order = Number.isFinite(perOrder) && perOrder >= 0 ? perOrder : 2.00;
  row.disclosure_version = String(body.disclosure_version || META_UTILITY_DISCLOSURE_VERSION).trim()
    || META_UTILITY_DISCLOSURE_VERSION;
  // Always server-stamp — ignore client disclosure_accepted_at
  row.disclosure_accepted_at = new Date().toISOString();

  return row;
}

module.exports = {
  buildTenantInsertFields,
  featuresFromFulfillment,
  buildOpeningHours,
  truthy,
};
