'use strict';

const { supabase, supabaseAdmin } = require('../config/supabase');
const { sendTransactionalEmail } = require('./email');

const PRODUCTION_APP_ORIGIN = 'https://app.autom8.works';
const ALLOWED_RESET_ORIGINS = new Set([
  PRODUCTION_APP_ORIGIN,
  'https://autom8.works',
  'https://www.autom8.works',
  'https://owner.autom8.works',
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

/**
 * App URL with token_hash — bypasses Supabase Site URL (often stuck on localhost in dev).
 * User opens app.autom8.works/reset-password?token_hash=…&type=recovery directly.
 */
function buildDirectResetUrl(hashedToken, redirectTo) {
  if (!hashedToken) return null;
  const base = resolvePasswordResetRedirectUrl(redirectTo);
  const url = new URL(base);
  url.searchParams.set('token_hash', hashedToken);
  url.searchParams.set('type', 'recovery');
  return url.toString();
}

function patchRecoveryActionLink(actionLink, redirectTo) {
  if (!actionLink) return null;
  try {
    const url = new URL(actionLink);
    url.searchParams.set('redirect_to', resolvePasswordResetRedirectUrl(redirectTo));
    return url.toString();
  } catch {
    return actionLink;
  }
}

async function createRecoveryCredentials(email, redirectTo) {
  const normalized = String(email || '').trim().toLowerCase();
  const resetRedirect = resolvePasswordResetRedirectUrl(redirectTo);
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type:    'recovery',
    email:   normalized,
    options: { redirectTo: resetRedirect },
  });
  if (error) throw error;

  const props = data?.properties || {};
  const hashedToken = props.hashed_token || null;
  const actionLink = props.action_link || null;

  return {
    hashedToken,
    actionLink,
    directLink: buildDirectResetUrl(hashedToken, redirectTo),
    fallbackLink: patchRecoveryActionLink(actionLink, redirectTo),
    resetRedirect,
  };
}

function buildResetEmailContent(resetLink, { isOwner = false } = {}) {
  const accountLabel = isOwner ? 'Autom8 owner account' : 'Autom8 account';
  const subject = 'Reset your Autom8 password';
  const text = (
    `Hi,\n\n` +
    `Use this link to set a new password for your ${accountLabel}:\n\n` +
    `${resetLink}\n\n` +
    `This link expires in about an hour. If you did not request this, you can ignore this email.\n\n` +
    `— Autom8 / Munafe`
  );
  const html = (
    `<p>Hi,</p>` +
    `<p>Use this link to set a new password for your ${accountLabel}:</p>` +
    `<p><a href="${resetLink}">Reset password</a></p>` +
    `<p style="color:#666;font-size:13px">This link expires in about an hour. ` +
    `If you did not request this, you can ignore this email.</p>`
  );
  return { subject, text, html };
}

async function deliverResetLinkEmail(email, resetLink, { isOwner = false } = {}) {
  const { subject, text, html } = buildResetEmailContent(resetLink, { isOwner });

  if (process.env.RESEND_API_KEY) {
    await sendTransactionalEmail({ to: email, subject, text, html });
    return true;
  }

  console.warn('[password-reset] RESEND_API_KEY unset — falling back to Supabase auth email (check Site URL in dashboard)');
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: resolvePasswordResetRedirectUrl(null),
  });
  if (error) throw error;
  return true;
}

async function sendPasswordResetEmail(email, redirectTo, { isOwner = false } = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('Email is required');

  const creds = await createRecoveryCredentials(normalized, redirectTo);
  const resetLink = creds.directLink || creds.fallbackLink;
  if (!resetLink) throw new Error('Could not generate reset link');

  console.log(`[password-reset] redirectTo=${creds.resetRedirect} direct=${Boolean(creds.directLink)} owner=${isOwner}`);

  if (process.env.RESEND_API_KEY) {
    await deliverResetLinkEmail(normalized, resetLink, { isOwner });
    return { sent: true, resetLink };
  }

  console.warn('[password-reset] RESEND_API_KEY unset — falling back to Supabase auth email (check Site URL in dashboard)');
  const { error } = await supabase.auth.resetPasswordForEmail(normalized, {
    redirectTo: creds.resetRedirect,
  });
  if (error) throw error;
  return { sent: true, resetLink };
}

async function generateRecoveryLink(email, redirectTo) {
  const creds = await createRecoveryCredentials(email, redirectTo);
  return creds.directLink || creds.fallbackLink;
}

async function getManagerOwnerEmails(restaurantId, { excludeEmail = null } = {}) {
  if (!restaurantId) return { emails: [], restaurantName: 'Restaurant' };

  const [{ data: emps }, { data: rest }] = await Promise.all([
    supabaseAdmin
      .from('employees')
      .select('email, role')
      .eq('restaurant_id', restaurantId)
      .in('role', ['owner', 'manager'])
      .eq('is_active', true),
    supabaseAdmin
      .from('tenants')
      .select('contact_email, name')
      .eq('id', restaurantId)
      .maybeSingle(),
  ]);

  const skip = excludeEmail ? String(excludeEmail).trim().toLowerCase() : null;
  const emails = new Set();
  for (const row of emps ?? []) {
    if (!row.email) continue;
    const e = row.email.trim().toLowerCase();
    if (skip && e === skip) continue;
    emails.add(e);
  }
  if (rest?.contact_email) {
    const e = String(rest.contact_email).trim().toLowerCase();
    if (!(skip && e === skip)) emails.add(e);
  }

  return {
    emails:         [...emails],
    restaurantName: rest?.name || 'Restaurant',
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
  // Never email the requester the manager FYI — they need the real reset path.
  const { emails, restaurantName } = await getManagerOwnerEmails(restaurantId, {
    excludeEmail: employeeEmail,
  });
  if (!emails.length) {
    console.warn(`[password-reset] No other manager/owner email for restaurant ${restaurantId}`);
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
    // FYI-only (success path for staff). Do not claim a link was sent if we have none.
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
 * Send reset link to the account holder.
 * Owners: always get the real link email; never the manager FYI.
 * Staff: on delivery failure, managers get the one-time link (not an empty FYI).
 */
async function requestPasswordReset({
  email,
  employeeName = null,
  restaurantId = null,
  role = null,
  triggeredBy = 'self',
  redirectTo = null,
}) {
  const normalized = String(email || '').trim().toLowerCase();
  const isOwner = String(role || '').toLowerCase() === 'owner';
  let employeeNotified = false;
  let resetLink = null;

  try {
    const result = await sendPasswordResetEmail(normalized, redirectTo, { isOwner });
    employeeNotified = true;
    resetLink = result?.resetLink || null;
  } catch (err) {
    console.warn(`[password-reset] Reset email failed for ${normalized}:`, err.message);
  }

  // Owner self-service: never send manager FYI. Retry delivering the link if first send failed.
  if (isOwner) {
    if (employeeNotified) {
      return { employeeNotified: true, managersNotified: { sent: false, skipped: 'owner' }, resetLink };
    }

    try {
      resetLink = resetLink || await generateRecoveryLink(normalized, redirectTo);
    } catch (err) {
      console.warn(`[password-reset] generateLink failed for owner ${normalized}:`, err.message);
    }

    if (resetLink) {
      try {
        await deliverResetLinkEmail(normalized, resetLink, { isOwner: true });
        return {
          employeeNotified: true,
          managersNotified: { sent: false, skipped: 'owner' },
          resetLink,
        };
      } catch (err) {
        console.warn(`[password-reset] Owner link re-send failed for ${normalized}:`, err.message);
      }
    }

    throw new Error(
      'Could not send reset email. Try WhatsApp OTP on the forgot-password page, or contact Autom8 support.',
    );
  }

  // Staff: on failure, managers must receive the one-time link — never “a reset was sent” without one.
  let managersNotified = { sent: false };

  if (!employeeNotified) {
    try {
      resetLink = resetLink || await generateRecoveryLink(normalized, redirectTo);
    } catch (err) {
      console.warn(`[password-reset] generateLink failed for ${normalized}:`, err.message);
    }

    if (!resetLink) {
      throw new Error('Could not send reset email. Please contact your manager.');
    }

    try {
      managersNotified = await notifyManagersPasswordReset({
        employeeEmail:    normalized,
        employeeName,
        restaurantId,
        includeResetLink: true,
        resetLink,
        triggeredBy,
      });
    } catch (err) {
      console.warn('[password-reset] Manager email failed:', err.message);
      managersNotified = { sent: false, reason: err.message };
    }

    if (!managersNotified.sent) {
      // Last resort: deliver the link to the staff member again via Resend if managers unreachable
      try {
        await deliverResetLinkEmail(normalized, resetLink, { isOwner: false });
        return { employeeNotified: true, managersNotified, resetLink };
      } catch (err) {
        console.warn(`[password-reset] Staff fallback email failed for ${normalized}:`, err.message);
      }
      throw new Error('Could not send reset email. Please contact your manager.');
    }
  }

  return { employeeNotified, managersNotified, resetLink: resetLink || null };
}

module.exports = {
  FRONTEND_URL,
  resolveFrontendOrigin,
  resolvePasswordResetRedirectUrl,
  buildDirectResetUrl,
  createRecoveryCredentials,
  sendPasswordResetEmail,
  generateRecoveryLink,
  getManagerOwnerEmails,
  notifyManagersPasswordReset,
  requestPasswordReset,
};
