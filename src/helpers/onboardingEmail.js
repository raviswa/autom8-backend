'use strict';

/**
 * Send onboarding welcome via Gmail mailer.
 * Skips silently (with warning) when no email is on the tenant row.
 */

const { sendEmail } = require('../config/mailer');
const { onboardingWelcome } = require('./emailTemplates');
const { recordActivationEvent } = require('./tenantActivation');
const { isSupplyOptedIn } = require('./subscriptionPricing');

function resolveTenantEmail(tenant) {
  const raw =
    (tenant?.contact_email || '').trim()
    || (tenant?.email || '').trim()
    || '';
  if (!raw) return '';
  // Skip internal placeholders created for chain outlets without a real address.
  if (/@brand-.*\.internal$/i.test(raw) || /^outlet-\d+@/i.test(raw)) {
    return '';
  }
  return raw;
}

function resolveStorefrontUrl(tenant, opts = {}) {
  if (opts.storefrontUrl) return opts.storefrontUrl;
  const apiPublic = (
    process.env.API_PUBLIC_URL
    || process.env.PUBLIC_API_URL
    || 'https://api.autom8.works'
  ).replace(/\/$/, '');
  const slug = tenant?.slug && !String(tenant.slug).startsWith('pending-')
    ? tenant.slug
    : null;
  if (slug) return `${apiPublic}/cart?slug=${encodeURIComponent(slug)}`;
  if (tenant?.id) return `${apiPublic}/cart?restaurant_id=${encodeURIComponent(tenant.id)}`;
  return null;
}

function resolveSupplyPortalUrl(opts = {}) {
  if (opts.supplyPortalUrl) return opts.supplyPortalUrl;
  const base = (
    process.env.SUPPLY_FORM_BASE_URL
    || process.env.FRONTEND_URL
    || 'https://app.autom8.works'
  ).replace(/\/$/, '');
  return `${base}/supply/login`;
}

async function sendOnboardingWelcomeEmail(tenant, opts = {}) {
  if (!tenant) {
    console.warn('[email/onboarding] skip — no tenant');
    return { sent: false, reason: 'no_tenant' };
  }

  const to = resolveTenantEmail(tenant);
  if (!to) {
    console.warn('[email/onboarding] skip — contact_email/email is null', {
      tenant_id: tenant.id || null,
      name: tenant.name || null,
    });
    return { sent: false, reason: 'no_email' };
  }

  const frontend = (process.env.FRONTEND_URL || 'https://app.autom8.works').replace(/\/$/, '');
  const setupUrl = opts.setupUrl || `${frontend}/setup`;

  const supplyOn = isSupplyOptedIn(tenant) || opts.includeSupplyPortal === true;
  const isB2bOnly = ['b2b', 'supply', 'b2b_supply'].includes(
    String(tenant.lob_type || '').toLowerCase(),
  );
  const storefrontUrl = isB2bOnly && !opts.forceStorefront
    ? null
    : resolveStorefrontUrl(tenant, opts);
  const supplyPortalUrl = supplyOn ? resolveSupplyPortalUrl(opts) : null;

  try {
    const { subject, html, text } = onboardingWelcome(tenant, {
      setupUrl,
      storefrontUrl,
      supplyPortalUrl,
      hiccupNote: opts.hiccupNote || null,
    });
    const result = await sendEmail({ to, subject, html, text });
    if (result?.sent && tenant.id) {
      recordActivationEvent(tenant.id, 'welcome_email_sent', { to }).catch(() => {});
    }
    return result;
  } catch (err) {
    console.error('[email/onboarding] send failed', {
      tenant_id: tenant.id || null,
      to,
      error: err.message,
    });
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

module.exports = {
  sendOnboardingWelcomeEmail,
  resolveTenantEmail,
  resolveStorefrontUrl,
  resolveSupplyPortalUrl,
};
