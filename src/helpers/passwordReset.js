'use strict';

const { supabase, supabaseAdmin } = require('../config/supabase');
const { sendTransactionalEmail } = require('./email');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.autom8.works';

async function sendPasswordResetEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('Email is required');

  const { error } = await supabase.auth.resetPasswordForEmail(normalized, {
    redirectTo: `${FRONTEND_URL}/reset-password`,
  });
  if (error) throw error;
  return true;
}

async function generateRecoveryLink(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type:    'recovery',
    email:   normalized,
    options: { redirectTo: `${FRONTEND_URL}/reset-password` },
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
}) {
  const normalized = String(email || '').trim().toLowerCase();
  let employeeNotified = false;
  let resetLink = null;

  try {
    await sendPasswordResetEmail(normalized);
    employeeNotified = true;
  } catch (err) {
    console.warn(`[password-reset] Supabase email failed for ${normalized}:`, err.message);
  }

  let managersNotified = { sent: false };

  if (!employeeNotified) {
    try {
      resetLink = await generateRecoveryLink(normalized);
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
  sendPasswordResetEmail,
  generateRecoveryLink,
  getManagerOwnerEmails,
  notifyManagersPasswordReset,
  requestPasswordReset,
};
