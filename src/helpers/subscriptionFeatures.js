'use strict';

// Customer-facing order services (toggleable in Settings → Services)
const ORDER_SERVICES = ['dine_in', 'takeaway', 'delivery', 'reserve_table'];

// Platform capabilities billed alongside services (not toggled in Services tab)
const INFRA_FEATURES = [
  'token_management', 'kds', 'analytics', 'marketing',
  'whatsapp_ordering', 'catalog_sync', 'reporting',
];

const ALL_FEATURES = [...ORDER_SERVICES, ...INFRA_FEATURES];

const SERVICE_LABELS = {
  dine_in:       'Dine-in',
  takeaway:      'Takeaway',
  delivery:      'Door delivery',
  reserve_table: 'Table reservation',
};

function isOrderService(feature) {
  return ORDER_SERVICES.includes(feature);
}

/**
 * Paid plan from billing (restaurant_subscriptions.features).
 * Legacy restaurants without a subscription row get full trial access.
 */
function resolvePaidFeatures(subscriptionRow) {
  if (subscriptionRow?.features?.length) {
    return [...subscriptionRow.features];
  }
  return [...ALL_FEATURES];
}

/**
 * Currently active features on the restaurant row, clamped to the paid plan.
 */
function resolveEnabledFeatures(restaurantRow, paidFeatures) {
  const paid = paidFeatures || ALL_FEATURES;
  const raw = restaurantRow?.subscribed_features?.length
    ? restaurantRow.subscribed_features
    : paid;
  return raw.filter(f => paid.includes(f));
}

/** Order services that are currently enabled for customers. */
function enabledOrderServices(enabledFeatures) {
  return ORDER_SERVICES.filter(s => enabledFeatures.includes(s));
}

/**
 * Build subscribed_features from owner-selected services + auto-included infra.
 */
function mergeEnabledFeatures(enabledServices, paidFeatures) {
  const paid = paidFeatures || ALL_FEATURES;
  const services = (enabledServices || []).filter(s => paid.includes(s));
  const infra = paid.filter(f => !isOrderService(f));
  return [...new Set([...services, ...infra])];
}

function validateEnabledFeatures(enabledFeatures, paidFeatures) {
  const paid = paidFeatures || ALL_FEATURES;
  const enabled = enabledFeatures || [];

  const notPaid = enabled.filter(f => !paid.includes(f));
  if (notPaid.length) {
    const labels = notPaid.map(f => SERVICE_LABELS[f] || f).join(', ');
    return {
      ok: false,
      error: `Cannot enable features not on your plan: ${labels}. Contact Autom8 to upgrade.`,
    };
  }

  const activeServices = enabled.filter(isOrderService);
  if (activeServices.length < 1) {
    return { ok: false, error: 'At least one customer-facing service must be enabled.' };
  }

  return { ok: true };
}

module.exports = {
  ORDER_SERVICES,
  INFRA_FEATURES,
  ALL_FEATURES,
  SERVICE_LABELS,
  isOrderService,
  resolvePaidFeatures,
  resolveEnabledFeatures,
  enabledOrderServices,
  mergeEnabledFeatures,
  validateEnabledFeatures,
};
