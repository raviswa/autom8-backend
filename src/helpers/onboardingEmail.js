'use strict';

/**
 * Send onboarding welcome via Gmail mailer.
 * Skips silently (with warning) when no email is on the tenant row.
 */

const { sendEmail } = require('../config/mailer');
const { onboardingWelcome } = require('./emailTemplates');

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

async function sendOnboardingWelcomeEmail(tenant) {
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

  try {
    const { subject, html, text } = onboardingWelcome(tenant);
    return await sendEmail({ to, subject, html, text });
  } catch (err) {
    console.error('[email/onboarding] send failed', {
      tenant_id: tenant.id || null,
      to,
      error: err.message,
    });
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

module.exports = { sendOnboardingWelcomeEmail, resolveTenantEmail };
