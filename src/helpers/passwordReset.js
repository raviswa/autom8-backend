'use strict';

const { supabase, supabaseAdmin } = require('../config/supabase');
const { sendTransactionalEmail } = require('./email');

const PRODUCTION_APP_ORIGIN = 'https://app.autom8.works';
const ALLOWED_RESET_ORIGINS = new Set([
  PRODUCTION_APP_ORIGIN,
  'https://autom8.works',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
]);

function resolveFrontendOrigin() {
  const fromEnv = (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    if (fromEnv && !/localhost|127\.0\.0\.1/i.test(fromEnv)) {
      try {
        return new URL(fromEnv).origin;
      } catch (_) {
        return PRODUCTION_APP_ORIGIN;
      }
    }
    return PRODUCTION_APP_ORIGIN;
  }

  if (fromEnv) {
    try {
      return new URL(fromEnv).origin;
    } catch (_) {}
  }
  return 'http://localhost:5173';
}

/**
 * Password-reset links must land on the app the user is using, not localhost in prod.
 * Accepts optional redirectTo from the browser (e.g. https://app.autom8.works/reset-password).
 */
function resolvePasswordResetRedirectUrl(redirectTo) {
  const fallback = `${resolveFrontendOrigin()}/reset-password`;

  if (!redirectTo || typeof redirectTo !== 'string') {
    return fallback;
  }

  try {
    const url = new URL(redirectTo.trim());
    if (!ALLOWED_RESET_ORIGINS.has(url.origin)) {
      console.warn(`[password-reset] Rejected redirect origin ${url.origin} — using fallback`);
      return fallback;
    }
    url.hash = '';
    url.search = '';
    if (!url.pathname.endsWith('/reset-password')) {
      url.pathname = '/reset-password';
    }
    return url.toString();
  } catch (_) {
    return fallback;
  }
}

const FRONTEND_URL = resolveFrontendOrigin();

async function sendPasswordResetEmail(email, redirectTo) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('Email is required');

  const resetRedirect = resolvePasswordResetRedirectUrl(redirectTo);
  console.log(`[password-reset] redirectTo=${resetRedirect}`);

  const { error } = await supabase.auth.resetPasswordForEmail(normalized, {
    redirectTo: resetRedirect,
  });
  if (error) throw error;
  return true;
}

async function generateRecoveryLink(email, redirectTo) {
  const normalized = String(email || '').trim().toLowerCase();
  const resetRedirect = resolvePasswordResetRedirectUrl(redirectTo);
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type:    'recovery',
    email:   normalized,
    options: { redirectTo: resetRedirect },
  });
  if (error) throw error;
  return data?.properties?.action_link || null;
}

async function getManagerOwnerEmails(restaurantId) {
  if (!restaurantId) return { emails: [], restaurantName: 'Restaurant' };

  const [{ data: emps }, { data: rest }] = await Promise.all([
    supabaseAdmin
      .from('employees')
      .select('email, role')
      .eq('restaurant_id', restaurantId)
      .in('role', ['owner', 'manager'])
      .eq('is_active', true),
    supabaseAdmin
      .from('restaurants')
      .select('contact_email, name')
      .eq('id', restaurantId)
      .maybeSingle(),
  ]);

  const emails = new Set();
  for (const row of emps ?? []) {
    if (row.email) emails.add(row.email.trim().toLowerCase());
  }
  if (rest?.contact_email) {
    emails.add(String(rest.contact_email).trim().toLowerCase());
  }

  return {
    emails:          [...emails],
    restaurantName:  rest?.name || 'Restaurant',
  };
}

async function notifyManagersPasswordReset({
  employeeEmail,
  employeeName,
  restaurantId,
  includeResetLink = false,
  resetLink = null,
  triggeredBy = 'self',
}) {
  const { emails, restaurantName } = await getManagerOwnerEmails(restaurantId);
  if (!emails.length) {
    console.warn(`[password-reset] No manager/owner email for restaurant ${restaurantId}`);
    return { sent: false, reason: 'no_manager_emails' };
  }

  const who = employeeName || employeeEmail;
  const triggerLine = triggeredBy === 'self'
    ? `${who} (${employeeEmail}) requested a password reset via the login page.`
    : triggeredBy === 'onboarding'
      ? `A new staff account was created for ${who} (${employeeEmail}).`
      : `A password reset was triggered for ${who} (${employeeEmail}) from the staff settings.`;

  let body = (
    `Password reset — ${restaurantName}\n\n` +
    `${triggerLine}\n\n`
  );

  if (includeResetLink && resetLink) {
    body += (
      `The automated email to the staff member may not have been delivered.\n` +
      `Please forward this one-time reset link to them:\n\n` +
      `${resetLink}\n\n` +
      `The link expires after a short period. They can also use Settings → Staff → Reset password in the manager portal.\n\n`
    );
  } else {
    body += (
      `A reset email has been sent to ${employeeEmail}.\n` +
      `If they do not receive it, use Settings → Staff → Reset password in the manager portal.\n\n`
    );
  }

  body += `Login portal: ${FRONTEND_URL}/login\n`;

  const subject = includeResetLink
    ? `[Autom8] Password reset link for ${who} — action needed`
    : `[Autom8] Password reset requested for ${who}`;

  return sendTransactionalEmail({
    to:      emails,
    subject,
    text:    body,
  });
}

/**
 * Send Supabase reset to employee; on failure, email manager/owner with recovery link.
 */
async function requestPasswordReset({
  email,
  employeeName = null,
  restaurantId = null,
  triggeredBy = 'self',
  redirectTo = null,
}) {
  const normalized = String(email || '').trim().toLowerCase();
  let employeeNotified = false;
  let resetLink = null;

  try {
    await sendPasswordResetEmail(normalized, redirectTo);
    employeeNotified = true;
  } catch (err) {
    console.warn(`[password-reset] Supabase email failed for ${normalized}:`, err.message);
  }

  let managersNotified = { sent: false };

  if (!employeeNotified) {
    try {
      resetLink = await generateRecoveryLink(normalized, redirectTo);
    } catch (err) {
      console.warn(`[password-reset] generateLink failed for ${normalized}:`, err.message);
    }

    try {
      managersNotified = await notifyManagersPasswordReset({
        employeeEmail:    normalized,
        employeeName,
        restaurantId,
        includeResetLink: Boolean(resetLink),
        resetLink,
        triggeredBy,
      });
    } catch (err) {
      console.warn('[password-reset] Manager email failed:', err.message);
      managersNotified = { sent: false, reason: err.message };
    }
  }

  if (!employeeNotified && !managersNotified.sent) {
    throw new Error('Could not send reset email. Please contact your manager.');
  }

  return { employeeNotified, managersNotified, resetLink: resetLink || null };
}

module.exports = {
  FRONTEND_URL,
  resolveFrontendOrigin,
  resolvePasswordResetRedirectUrl,
  sendPasswordResetEmail,
  generateRecoveryLink,
  getManagerOwnerEmails,
  notifyManagersPasswordReset,
  requestPasswordReset,
};
