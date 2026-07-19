'use strict';

/**
 * One-time notify after token_management backfill.
 *
 * Usage (ONLY after dry-run + apply are approved):
 *   node scripts/notify_token_queue_feature.js --dry-run
 *   node scripts/notify_token_queue_feature.js --send
 *
 * WhatsApp: notify.js TEMPLATES.token_queue_feature_live (+ text fallback)
 * Email:    src/config/mailer.js + emailTemplates.tokenQueueFeatureLive
 */

require('dotenv').config();

const { supabaseAdmin } = require('../src/config/supabase');
const { sendEmail } = require('../src/config/mailer');
const { tokenQueueFeatureLive } = require('../src/helpers/emailTemplates');
const { sendSubscriptionWhatsAppTemplate } = require('../src/routes/supply/notify');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function hasTokenManagement(features) {
  if (!features) return false;
  if (Array.isArray(features)) return features.includes('token_management');
  if (typeof features === 'object') return !!features.token_management;
  if (typeof features === 'string') {
    try {
      const parsed = JSON.parse(features);
      if (Array.isArray(parsed)) return parsed.includes('token_management');
      if (parsed && typeof parsed === 'object') return !!parsed.token_management;
    } catch (_) {
      return features.split(',').map(s => s.trim()).includes('token_management');
    }
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = !args.send || !!args['dry-run'];

  const { data: tenants, error } = await supabaseAdmin
    .from('tenants')
    .select('id, name, subscribed_features, services_enabled, manager_phone, contact_email, email, is_active')
    .eq('is_active', true);

  if (error) {
    console.error('[notify_token_queue] fetch failed:', error.message);
    process.exit(1);
  }

  const eligible = (tenants || []).filter(t =>
    hasTokenManagement(t.services_enabled) || hasTokenManagement(t.subscribed_features),
  );

  console.log(`[notify_token_queue] mode=${dryRun ? 'DRY-RUN' : 'SEND'} eligible=${eligible.length}`);

  let waOk = 0;
  let waSkip = 0;
  let emailOk = 0;
  let emailSkip = 0;
  let failed = 0;

  for (const t of eligible) {
    const phone = t.manager_phone;
    const email = (t.contact_email || t.email || '').trim();

    if (dryRun) {
      console.log(
        `  WOULD notify ${t.name} (${t.id}) wa=${phone || '—'} email=${email || '—'}`,
      );
      continue;
    }

    try {
      if (phone) {
        const wa = await sendSubscriptionWhatsAppTemplate({
          entityType: 'tenant',
          templateKey: 'token_queue_feature_live',
          params: { business_name: t.name || 'your business' },
          toPhone: phone,
          restaurantId: t.id,
          fallbackText:
            `Hi — update for *${t.name || 'your business'}*:\n\n`
            + `New: your customers can now grab a queue token directly on WhatsApp — `
            + `no extra setup needed. This shows up as '🎫 Token / Queue' in their `
            + `ordering menu alongside your existing options.`,
        });
        if (wa.ok) waOk += 1;
        else if (wa.skipped) waSkip += 1;
        else {
          failed += 1;
          console.error('[notify_token_queue] WA failed', t.id, wa.error);
        }
      } else {
        waSkip += 1;
      }

      if (email) {
        const tpl = tokenQueueFeatureLive(t);
        const result = await sendEmail({
          to: email,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
        });
        if (result.sent) emailOk += 1;
        else emailSkip += 1;
      } else {
        emailSkip += 1;
        console.warn('[notify_token_queue] no email for', t.id, t.name);
      }
    } catch (err) {
      failed += 1;
      console.error('[notify_token_queue] tenant failed', t.id, err.message);
    }
  }

  console.log('[notify_token_queue] done', {
    eligible: eligible.length,
    waOk,
    waSkip,
    emailOk,
    emailSkip,
    failed,
    dryRun,
  });
}

main().catch((err) => {
  console.error('[notify_token_queue] fatal:', err.message);
  process.exit(1);
});
