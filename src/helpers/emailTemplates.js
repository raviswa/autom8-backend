'use strict';

/**
 * Email templates for onboarding / billing / referrals.
 * Shape mirrors supply notify.js TEMPLATES: plain functions → { subject, html, text }.
 * Keep copy direct and factual — same tone as operational WhatsApp messages.
 */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tenantLabel(tenant) {
  return tenant?.name || tenant?.display_name || 'your restaurant';
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch (_) {
    return String(iso);
  }
}

function wrap(bodyHtml) {
  return `<!DOCTYPE html>
<html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111;">
${bodyHtml}
<p style="margin-top:24px;color:#555;">— Autom8</p>
</body></html>`;
}

/** Sent once when a tenant is created / activated. */
function onboardingWelcome(tenant, opts = {}) {
  const name = tenantLabel(tenant);
  const setupUrl = opts.setupUrl || 'https://app.autom8.works/setup';
  const hiccup = opts.hiccupNote ? String(opts.hiccupNote).trim() : '';
  const subject = `Welcome to Autom8 — ${name}`;
  const text =
    `Hi,\n\n` +
    `${name} is set up on Autom8.\n` +
    `Open your setup checklist: ${setupUrl}\n` +
    `Track what's done and what's pending:\n` +
    `- Account created\n` +
    `- WhatsApp connected\n` +
    `- Catalog uploaded\n` +
    `- Fulfillment modes configured\n` +
    (hiccup ? `\nNote: ${hiccup}\n` : '') +
    `\nSign in at https://app.autom8.works if you are not already logged in.\n` +
    `If you did not expect this email, reply and we will sort it out.\n`;
  const html = wrap(
    `<p>Hi,</p>
     <p><strong>${esc(name)}</strong> is set up on Autom8.</p>
     <p><a href="${esc(setupUrl)}" style="display:inline-block;padding:10px 16px;background:#047857;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Open setup checklist</a></p>
     <p>Use the checklist to see what is done and what is still pending:</p>
     <ul>
       <li>Account created</li>
       <li>WhatsApp connected</li>
       <li>Catalog uploaded</li>
       <li>Fulfillment modes configured</li>
     </ul>` +
      (hiccup ? `<p><strong>Note:</strong> ${esc(hiccup)}</p>` : '') +
      `<p>Sign in at <a href="https://app.autom8.works">https://app.autom8.works</a> if needed.</p>
     <p>If you did not expect this email, reply and we will sort it out.</p>`,
  );
  return { subject, html, text };
}

/** T-7 / T-3 / T-1 style trial ending reminder. */
function trialEndingReminder(tenant, daysLeft) {
  const name = tenantLabel(tenant);
  const days = Number(daysLeft);
  const subject =
    days === 1
      ? `Trial ends tomorrow — ${name}`
      : `Trial ends in ${days} days — ${name}`;
  const text =
    `Hi,\n\n` +
    `The Autom8 trial for ${name} ends in ${days} day${days === 1 ? '' : 's'}` +
    (tenant?.trial_ends_at ? ` (on ${formatDate(tenant.trial_ends_at)})` : '') +
    `.\n` +
    `Reply to this email or WhatsApp us if you want to continue on a paid plan.\n`;
  const html = wrap(
    `<p>Hi,</p>
     <p>The Autom8 trial for <strong>${esc(name)}</strong> ends in ` +
      `<strong>${esc(days)}</strong> day${days === 1 ? '' : 's'}` +
      (tenant?.trial_ends_at ? ` (on ${esc(formatDate(tenant.trial_ends_at))})` : '') +
      `.</p>
     <p>Reply to this email or WhatsApp us if you want to continue on a paid plan.</p>`,
  );
  return { subject, html, text };
}

/** Mirrors tenant_payment_due WhatsApp intent. */
function paymentDue(tenant, amount, paymentLinkUrl) {
  const name = tenantLabel(tenant);
  const amt = Number(amount || 0);
  const subject = `Payment due — ${name}`;
  const linkLine = paymentLinkUrl
    ? `Pay here: ${paymentLinkUrl}\n`
    : 'We will share a payment link shortly.\n';
  const text =
    `Hi,\n\n` +
    `Payment of ₹${amt.toFixed(0)} is due for ${name}.\n` +
    linkLine;
  const html = wrap(
    `<p>Hi,</p>
     <p>Payment of <strong>₹${esc(amt.toFixed(0))}</strong> is due for <strong>${esc(name)}</strong>.</p>` +
      (paymentLinkUrl
        ? `<p><a href="${esc(paymentLinkUrl)}">Pay here</a></p>`
        : `<p>We will share a payment link shortly.</p>`),
  );
  return { subject, html, text };
}

function paymentOverdue(tenant, amount, gracePeriodEnd) {
  const name = tenantLabel(tenant);
  const amt = Number(amount || 0);
  const subject = `Payment overdue — ${name}`;
  const text =
    `Hi,\n\n` +
    `Payment of ₹${amt.toFixed(0)} for ${name} is overdue.\n` +
    (gracePeriodEnd
      ? `Grace period ends ${formatDate(gracePeriodEnd)}.\n`
      : '') +
    `Please pay or reply if you need help.\n`;
  const html = wrap(
    `<p>Hi,</p>
     <p>Payment of <strong>₹${esc(amt.toFixed(0))}</strong> for <strong>${esc(name)}</strong> is overdue.</p>` +
      (gracePeriodEnd
        ? `<p>Grace period ends <strong>${esc(formatDate(gracePeriodEnd))}</strong>.</p>`
        : '') +
      `<p>Please pay or reply if you need help.</p>`,
  );
  return { subject, html, text };
}

/**
 * Sent to the REFERRER after a successful credit.
 * tier: optional { tier_order, note, bonus_days } from referral_program_tiers.
 */
function referralCredited(opts) {
  const {
    tenant,
    bonusDays,
    newExpiryDate,
    referredName,
    tier,
  } = opts;
  const name = tenantLabel(tenant);
  const days = Number(bonusDays || 0);
  const who = referredName || 'your referral';
  const freeMonth = days >= 28 && days <= 31;
  const tierLabel = !freeMonth && tier?.tier_order
    ? ` (tier ${tier.tier_order} bonus)`
    : '';
  const rewardLine = freeMonth
    ? '1 free month (we will not charge for that cycle)'
    : `${days} free days${tierLabel}`;
  const subject = freeMonth
    ? `Referral credited — 1 free month added`
    : `Referral credited — ${days} free days added`;
  const text =
    `Hi,\n\n` +
    `Thank you for referring ${who}.\n` +
    `You earned ${rewardLine}.\n` +
    (newExpiryDate ? `New access / billing date: ${formatDate(newExpiryDate)}.\n` : '') +
    `This applies to ${name}.\n`;
  const html = wrap(
    `<p>Hi,</p>
     <p>Thank you for referring <strong>${esc(who)}</strong>.</p>
     <p>You earned <strong>${esc(rewardLine)}</strong>.</p>` +
      (newExpiryDate
        ? `<p>New access / billing date: <strong>${esc(formatDate(newExpiryDate))}</strong>.</p>`
        : '') +
      `<p>This applies to <strong>${esc(name)}</strong>.</p>`,
  );
  return { subject, html, text };
}

function entityLabel(entity, entityType) {
  if (entityType === 'supplier') {
    return entity?.business_name || entity?.name || 'your supply account';
  }
  return tenantLabel(entity);
}

/**
 * Shared billing cadence templates (tenant + supplier).
 * reminderType: ending_soon | ending_soon_final | due_today | overdue_1 | overdue_2 | grace_expired
 */
function billingReminderEmail({ entity, entityType, reminderType, amount, paymentLinkUrl, anchorDate, graceEndsAt }) {
  const name = entityLabel(entity, entityType);
  const amt = Number(amount || 0);
  const kind = entityType === 'supplier' ? 'Supply' : 'Autom8';
  const linkLine = paymentLinkUrl ? `Pay here: ${paymentLinkUrl}\n` : '';

  const copy = {
    ending_soon: {
      subject: `${kind} subscription ends in 7 days — ${name}`,
      body:
        `${kind} billing for ${name} renews/ends on ${formatDate(anchorDate)} (in 7 days).\n`
        + `Amount: ₹${amt.toFixed(0)}.\n`,
    },
    ending_soon_final: {
      subject: `${kind} subscription ends in 3 days — ${name}`,
      body:
        `${kind} billing for ${name} renews/ends on ${formatDate(anchorDate)} (in 3 days).\n`
        + `Amount: ₹${amt.toFixed(0)}.\n`
        + linkLine,
    },
    due_today: {
      subject: `${kind} payment due today — ${name}`,
      body:
        `Payment of ₹${amt.toFixed(0)} is due today for ${name}.\n`
        + linkLine,
    },
    overdue_1: {
      subject: `${kind} payment overdue (5 days) — ${name}`,
      body:
        `Payment of ₹${amt.toFixed(0)} for ${name} is 5 days overdue.\n`
        + (graceEndsAt ? `Grace period ends ${formatDate(graceEndsAt)}.\n` : '')
        + linkLine,
    },
    overdue_2: {
      subject: `${kind} payment overdue (10 days) — ${name}`,
      body:
        `Payment of ₹${amt.toFixed(0)} for ${name} is 10 days overdue.\n`
        + `If unpaid by ${formatDate(graceEndsAt)}, new orders and campaign sends will be paused (history and payments stay available).\n`
        + linkLine,
    },
    grace_expired: {
      subject: `${kind} grace period ended — ${name}`,
      body:
        `The grace period for ${name} has ended. New orders and campaign sends are paused until payment of ₹${amt.toFixed(0)} is received.\n`
        + `You can still view history and pay.\n`
        + linkLine,
    },
  };

  const entry = copy[reminderType] || {
    subject: `${kind} billing notice — ${name}`,
    body: `A billing notice for ${name}.\n${linkLine}`,
  };

  const text = `Hi,\n\n${entry.body}\n`;
  const html = wrap(
    `<p>Hi,</p><p>${esc(entry.body).replace(/\n/g, '<br>')}</p>`
    + (paymentLinkUrl && reminderType !== 'ending_soon'
      ? `<p><a href="${esc(paymentLinkUrl)}">Pay here</a></p>`
      : ''),
  );
  return { subject: entry.subject, html, text };
}

function supplierOnboardingWelcome(supplier) {
  const name = entityLabel(supplier, 'supplier');
  const subject = `Welcome to Autom8 Supply — ${name}`;
  const text =
    `Hi,\n\n${name} is set up on Autom8 Supply.\n`
    + `Your trial is 30 days. Sign in when you are ready.\n`;
  const html = wrap(
    `<p>Hi,</p>
     <p><strong>${esc(name)}</strong> is set up on Autom8 Supply.</p>
     <p>Your trial is 30 days. Sign in when you are ready.</p>`,
  );
  return { subject, html, text };
}

/** One-time notice after token_management backfill. */
function tokenQueueFeatureLive(tenant) {
  const name = tenantLabel(tenant);
  const subject = `New WhatsApp option: Token / Queue — ${name}`;
  const text =
    `Hi,\n\n` +
    `Update for ${name}:\n\n` +
    `New: your customers can now grab a queue token directly on WhatsApp — ` +
    `no extra setup needed. This shows up as "Token / Queue" in their ` +
    `ordering menu alongside your existing options.\n`;
  const html = wrap(
    `<p>Hi,</p>
     <p>Update for <strong>${esc(name)}</strong>:</p>
     <p>New: your customers can now grab a queue token directly on WhatsApp — ` +
      `no extra setup needed. This shows up as <strong>🎫 Token / Queue</strong> ` +
      `in their ordering menu alongside your existing options.</p>`,
  );
  return { subject, html, text };
}

module.exports = {
  onboardingWelcome,
  trialEndingReminder,
  paymentDue,
  paymentOverdue,
  referralCredited,
  billingReminderEmail,
  supplierOnboardingWelcome,
  tokenQueueFeatureLive,
};
