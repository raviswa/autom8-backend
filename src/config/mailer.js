'use strict';

/**
 * Gmail SMTP transport for onboarding / billing / referral emails.
 *
 * Env (never hardcode credentials):
 *   GMAIL_USER          — e.g. autom8.works@gmail.com
 *   GMAIL_APP_PASSWORD  — 16-char Google App Password (2-Step Verification required),
 *                         NOT the regular Gmail account password.
 *
 * Gmail free-tier sending cap is roughly ~500 messages/day. Fine for current
 * onboarding volume; revisit (dedicated ESP / workspace SMTP) before scale.
 *
 * Password-reset mail still uses Resend via src/helpers/email.js — this
 * mailer is the Gmail path for the referral + billing email layer.
 */

const nodemailer = require('nodemailer');

function summarizeMailError(err) {
  if (!err) return null;
  return {
    message: err.message || null,
    code: err.code || null,
    response: err.response || null,
    responseCode: err.responseCode || null,
    command: err.command || null,
  };
}

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const user = (process.env.GMAIL_USER || '').trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || '').trim();

  if (!user || !pass) {
    return null;
  }

  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  return _transporter;
}

/**
 * Send an email via Gmail SMTP.
 * @returns {{ sent: boolean, reason?: string, messageId?: string }}
 */
async function sendEmail({ to, subject, html, text }) {
  const recipients = (Array.isArray(to) ? to : [to])
    .map((e) => String(e || '').trim().toLowerCase())
    .filter(Boolean);

  if (!recipients.length) {
    console.warn('[mailer] sendEmail skipped — no recipients', { subject });
    return { sent: false, reason: 'no_recipients' };
  }

  const user = (process.env.GMAIL_USER || '').trim();
  const transporter = getTransporter();

  if (!transporter) {
    console.error('[mailer] sendEmail failed — Gmail not configured', {
      subject,
      to: recipients,
      missing: {
        GMAIL_USER: !user,
        GMAIL_APP_PASSWORD: !(process.env.GMAIL_APP_PASSWORD || '').trim(),
      },
    });
    return { sent: false, reason: 'not_configured' };
  }

  try {
    const info = await transporter.sendMail({
      from: `Autom8 <${user}>`,
      to: recipients.join(', '),
      subject,
      text: text || (html ? html.replace(/<[^>]+>/g, ' ') : ''),
      html: html || undefined,
    });

    console.log(`[mailer] ✅ Sent "${subject}" → ${recipients.join(', ')}`, {
      messageId: info.messageId || null,
    });
    return { sent: true, messageId: info.messageId, recipients };
  } catch (err) {
    console.error('[mailer] sendEmail failed', {
      subject,
      to: recipients,
      error: summarizeMailError(err),
    });
    throw err;
  }
}

module.exports = { sendEmail, getTransporter };
