'use strict';

/**
 * Daily churn win-back outreach (mirrors billingReminders structure).
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const { sendEmail } = require('../config/mailer');
const { missYouEmail } = require('./emailTemplates');
const { resolveTenantEmail } = require('./onboardingEmail');
const { recordActivationEvent } = require('./tenantActivation');
const { isLifetimeTenant } = require('./subscriptionAccess');

const FEEDBACK_REASONS = [
  'too_expensive',
  'too_complex',
  'found_alternative',
  'seasonal_pause',
  'technical_issues',
  'other',
];

function feedbackTokenSecret() {
  return (
    process.env.CHURN_FEEDBACK_TOKEN_SECRET
    || process.env.AUTOM8_KDS_SECRET
    || 'dev-churn-feedback'
  );
}

function signFeedbackToken(tenantId, expMs) {
  const payload = Buffer.from(JSON.stringify({
    tid: tenantId,
    exp: expMs,
  })).toString('base64url');
  const sig = crypto
    .createHmac('sha256', feedbackTokenSecret())
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

function verifyFeedbackToken(token) {
  const raw = String(token || '');
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const expected = crypto
    .createHmac('sha256', feedbackTokenSecret())
    .update(payload)
    .digest('base64url');
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.tid || !data?.exp || Date.now() > Number(data.exp)) return null;
    return data;
  } catch {
    return null;
  }
}

async function loadIdleThresholds() {
  const { data } = await supabaseAdmin
    .from('churn_idle_thresholds')
    .select('lob_type, idle_days');
  const map = Object.fromEntries((data || []).map((r) => [r.lob_type, r.idle_days]));
  return {
    map,
    defaultDays: map.default || 30,
  };
}

function idleDaysFromInterval(interval) {
  if (interval == null) return null;
  // Postgres interval may arrive as string "21 days" or object
  if (typeof interval === 'object' && interval.days != null) {
    return Number(interval.days) + (Number(interval.hours || 0) / 24);
  }
  const s = String(interval);
  const m = s.match(/(\d+)\s*days?/i);
  if (m) return parseInt(m[1], 10);
  // ISO-ish duration
  const dayMatch = s.match(/P(?:(\d+)D)?/i);
  if (dayMatch && dayMatch[1]) return parseInt(dayMatch[1], 10);
  return null;
}

async function alreadySent(tenantId, outreachType) {
  const { data } = await supabaseAdmin
    .from('churn_outreach_sent')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('outreach_type', outreachType)
    .maybeSingle();
  return Boolean(data?.id);
}

async function markSent(tenantId, outreachType) {
  await supabaseAdmin.from('churn_outreach_sent').upsert({
    tenant_id: tenantId,
    outreach_type: outreachType,
    sent_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,outreach_type' });
}

async function clearOutreach(tenantId) {
  await supabaseAdmin.from('churn_outreach_sent').delete().eq('tenant_id', tenantId);
}

async function sendMissYou(tenant, outreachType) {
  const to = resolveTenantEmail(tenant);
  if (!to) return { sent: false, reason: 'no_email' };

  const frontend = (process.env.FRONTEND_URL || 'https://app.autom8.works').replace(/\/$/, '');
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const token = signFeedbackToken(tenant.id, exp);
  const feedbackBase = `${frontend}/churn-feedback`;
  const { subject, html, text } = missYouEmail(tenant, {
    outreachType,
    feedbackBaseUrl: feedbackBase,
    token,
    reasons: FEEDBACK_REASONS,
  });
  return sendEmail({ to, subject, html, text });
}

/**
 * Daily churn check. Safe to re-run — deduped by churn_outreach_sent.
 */
async function runChurnReminderCheck() {
  const { map, defaultDays } = await loadIdleThresholds();
  const { data: activity, error } = await supabaseAdmin
    .from('tenant_activity')
    .select('tenant_id, lob_type, is_active, last_order_at, lifetime_orders, idle_interval');
  if (error) {
    console.error('[churnReminders] tenant_activity query failed:', error.message);
    return { processed: 0, error: error.message };
  }

  const rows = activity || [];
  let missYou = 0;
  let missYouFinal = 0;
  let skipped = 0;

  for (const row of rows) {
    const tenantId = row.tenant_id;
    if (!tenantId || row.is_active === false) {
      skipped += 1;
      continue;
    }
    if (isLifetimeTenant(tenantId)) {
      skipped += 1;
      continue;
    }
    if (!row.last_order_at || !(row.lifetime_orders > 0)) {
      // Never ordered — onboarding problem, not churn win-back
      skipped += 1;
      continue;
    }

    const idleDays = idleDaysFromInterval(row.idle_interval);
    if (idleDays == null) {
      // Compute from last_order_at
      const last = new Date(row.last_order_at).getTime();
      const computed = Math.floor((Date.now() - last) / (24 * 60 * 60 * 1000));
      row._idleDays = computed;
    } else {
      row._idleDays = Math.floor(idleDays);
    }

    const threshold = map[row.lob_type] || defaultDays;
    const finalAt = threshold + 14;

    if (row._idleDays < threshold) {
      skipped += 1;
      continue;
    }

    const { data: tenant } = await supabaseAdmin
      .from('tenants')
      .select('id, name, display_name, email, contact_email, lob_type')
      .eq('id', tenantId)
      .maybeSingle();
    if (!tenant) {
      skipped += 1;
      continue;
    }

    if (row._idleDays >= finalAt) {
      if (!(await alreadySent(tenantId, 'miss_you_final'))) {
        // Ensure miss_you exists first
        if (!(await alreadySent(tenantId, 'miss_you'))) {
          const r1 = await sendMissYou(tenant, 'miss_you');
          if (r1.sent) {
            await markSent(tenantId, 'miss_you');
            missYou += 1;
          }
        }
        const r2 = await sendMissYou(tenant, 'miss_you_final');
        if (r2.sent) {
          await markSent(tenantId, 'miss_you_final');
          missYouFinal += 1;
        }
      } else {
        skipped += 1;
      }
      continue;
    }

    // Between threshold and final
    if (!(await alreadySent(tenantId, 'miss_you'))) {
      const r = await sendMissYou(tenant, 'miss_you');
      if (r.sent) {
        await markSent(tenantId, 'miss_you');
        missYou += 1;
      }
    } else {
      skipped += 1;
    }
  }

  console.log('[churnReminders] done', { missYou, missYouFinal, skipped, scanned: rows.length });
  return { processed: missYou + missYouFinal, missYou, missYouFinal, skipped };
}

/**
 * Call after a non-cancelled order is created for restaurantId.
 */
async function onOrderCreatedForChurn(restaurantId) {
  if (!restaurantId) return;
  try {
    const { count } = await supabaseAdmin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .neq('status', 'cancelled');
    if (count === 1) {
      await recordActivationEvent(restaurantId, 'first_order', {});
    }
    const { data: outreach } = await supabaseAdmin
      .from('churn_outreach_sent')
      .select('id')
      .eq('tenant_id', restaurantId)
      .limit(1);
    if (outreach?.length) {
      await recordActivationEvent(restaurantId, 'reactivated', { after_churn_outreach: true });
      await clearOutreach(restaurantId);
    }
  } catch (err) {
    console.warn('[churnReminders] onOrderCreatedForChurn:', err.message);
  }
}

module.exports = {
  FEEDBACK_REASONS,
  signFeedbackToken,
  verifyFeedbackToken,
  runChurnReminderCheck,
  onOrderCreatedForChurn,
  clearOutreach,
  alreadySent,
  markSent,
  sendMissYou,
};
