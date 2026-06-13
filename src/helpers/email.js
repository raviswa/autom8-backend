'use strict';

/**
 * Transactional email via Resend (https://resend.com).
 *
 * Env:
 *   RESEND_API_KEY  — required to send
 *   EMAIL_FROM      — e.g. "Autom8 <noreply@autom8.works>"
 */

async function sendTransactionalEmail({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'Autom8 <noreply@autom8.works>';

  const recipients = (Array.isArray(to) ? to : [to])
    .map(e => String(e || '').trim().toLowerCase())
    .filter(Boolean);

  if (!recipients.length) {
    return { sent: false, reason: 'no_recipients' };
  }

  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY not set — skipping mail to', recipients.join(', '));
    return { sent: false, reason: 'not_configured' };
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to:   recipients,
      subject,
      text,
      html: html || text.replace(/\n/g, '<br>'),
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Resend ${resp.status}: ${body.slice(0, 300)}`);
  }

  console.log(`[email] ✅ Sent "${subject}" → ${recipients.join(', ')}`);
  return { sent: true, recipients };
}

module.exports = { sendTransactionalEmail };
