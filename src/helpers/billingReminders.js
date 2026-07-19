'use strict';

/**
 * Unified SaaS billing reminder scheduler (tenants + suppliers).
 *
 * Cadence relative to trial_ends_at (status=trial) or renews_at (otherwise):
 *   T-7  ending_soon
 *   T-3  ending_soon_final + payment link
 *   T+0  due_today + payment link; set status overdue/past_due if unpaid
 *   T+5  overdue_1 + payment link
 *   T+10 overdue_2 + payment link + soft-lock warning
 *   T+15 grace_expired + soft lock active (isSubscriptionSoftLocked) + final notice
 *
 * Soft-lock condition (authoritative): daysPast(anchor) >= GRACE_PERIOD_DAYS
 * Status vocabulary:
 *   tenant   → past_due
 *   supplier → overdue
 *
 * Channels: Gmail mailer (emailTemplates.billingReminderEmail) + notify.js
 * TEMPLATES / sendSubscriptionWhatsAppTemplate — no third messaging path.
 *
 * Dedup: subscription_reminders_sent unique(entity_type, entity_id, reminder_type, cycle_anchor)
 * Insert only when neither channel hard-failed (skipped-missing-contact is OK).
 */

const { supabaseAdmin } = require('../config/supabase');
const { sendEmail } = require('../config/mailer');
const { billingReminderEmail } = require('./emailTemplates');
const { resolveTenantEmail } = require('./onboardingEmail');
const {
  GRACE_PERIOD_DAYS,
  CHECKPOINTS,
  summarizeError,
  toDateKey,
  daysRelativeToAnchor,
  getCycleAnchor,
  checkpointForRelativeDays,
  overdueStatusFor,
  isSubscriptionSoftLocked,
} = require('./subscriptionAccess');

const REMINDER_TYPE_TO_WA = {
  ending_soon: {
    tenant: 'tenant_subscription_ending_soon',
    supplier: 'supply_subscription_ending_soon',
  },
  ending_soon_final: {
    tenant: 'tenant_subscription_ending_soon_final',
    supplier: 'supply_subscription_ending_soon_final',
  },
  due_today: {
    tenant: 'tenant_subscription_due_today',
    supplier: 'supply_subscription_due_today',
  },
  overdue_1: {
    tenant: 'tenant_subscription_overdue_1',
    supplier: 'supply_subscription_overdue_1',
  },
  overdue_2: {
    tenant: 'tenant_subscription_overdue_2',
    supplier: 'supply_subscription_overdue_2',
  },
  grace_expired: {
    tenant: 'tenant_subscription_grace_expired',
    supplier: 'supply_subscription_grace_expired',
  },
};

function logBillingError(scope, error, context = {}) {
  console.error(`[billingReminders] ${scope} failed`, {
    ...context,
    error: error && error.message ? { message: error.message, ...summarizeError(error) } : summarizeError(error),
  });
}

function paymentLinkFor(entityType, entity, sub) {
  if (entity?.payment_link_url) return entity.payment_link_url;
  if (sub?.payment_link_url) return sub.payment_link_url;
  if (entityType === 'supplier') {
    const base = (process.env.SUPPLY_FRONTEND_URL || process.env.FRONTEND_URL || 'https://app.autom8.works').replace(/\/$/, '');
    return `${base}/supply/billing`;
  }
  const base = (process.env.FRONTEND_URL || 'https://app.autom8.works').replace(/\/$/, '');
  return `${base}/settings/billing`;
}

async function loadPendingPaymentLink(entityType, entityId) {
  try {
    if (entityType === 'tenant') {
      const { data } = await supabaseAdmin
        .from('tenant_subscription_payments')
        .select('payment_link_url')
        .eq('restaurant_id', entityId)
        .in('status', ['pending', 'created'])
        .not('payment_link_url', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.payment_link_url || null;
    }
    const { data } = await supabaseAdmin
      .from('supplier_subscription_payments')
      .select('payment_link_url')
      .eq('supplier_id', entityId)
      .eq('status', 'pending')
      .not('payment_link_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.payment_link_url || null;
  } catch (err) {
    logBillingError('loadPendingPaymentLink', err, { entityType, entityId });
    return null;
  }
}

async function alreadySent({ entityType, entityId, reminderType, cycleAnchor }) {
  const { data, error } = await supabaseAdmin
    .from('subscription_reminders_sent')
    .select('id')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .eq('reminder_type', reminderType)
    .eq('cycle_anchor', cycleAnchor)
    .maybeSingle();

  if (error) {
    logBillingError('alreadySent', error, { entityType, entityId, reminderType, cycleAnchor });
    return false;
  }
  return !!data;
}

async function recordSent({ entityType, entityId, subscriptionId, reminderType, cycleAnchor }) {
  const { error } = await supabaseAdmin.from('subscription_reminders_sent').insert({
    entity_type: entityType,
    entity_id: entityId,
    subscription_id: subscriptionId,
    reminder_type: reminderType,
    cycle_anchor: cycleAnchor,
  });
  if (error && error.code !== '23505') {
    logBillingError('recordSent', error, { entityType, entityId, reminderType, cycleAnchor });
    throw new Error(error.message);
  }
}

async function setOverdueStatus(entityType, subscriptionId) {
  const status = overdueStatusFor(entityType);
  const table = entityType === 'tenant' ? 'tenant_subscriptions' : 'supplier_subscriptions';
  const { error } = await supabaseAdmin
    .from(table)
    .update({
      status,
      ...(entityType === 'tenant' ? { updated_at: new Date().toISOString() } : {}),
    })
    .eq('id', subscriptionId)
    .neq('status', 'cancelled');

  if (error) {
    logBillingError('setOverdueStatus', error, { entityType, subscriptionId, status });
  } else {
    console.log(`[billingReminders] set ${table}.status=${status} id=${subscriptionId}`);
  }
}

async function sendEmailChannel({ entity, entityType, reminderType, amount, paymentLinkUrl, anchorDate, graceEndsAt }) {
  const to =
    entityType === 'tenant'
      ? resolveTenantEmail(entity)
      : String(entity?.email || '').trim().toLowerCase();

  if (!to) {
    console.warn('[billingReminders] email skipped — no address', {
      entityType,
      entity_id: entity?.id,
      reminderType,
    });
    return { ok: true, skipped: true, reason: 'no_email' };
  }

  try {
    const tpl = billingReminderEmail({
      entity,
      entityType,
      reminderType,
      amount,
      paymentLinkUrl,
      anchorDate,
      graceEndsAt,
    });
    const result = await sendEmail({ to, subject: tpl.subject, html: tpl.html, text: tpl.text });
    if (!result.sent) {
      return { ok: false, error: result.reason || 'email_not_sent' };
    }
    return { ok: true, sent: true };
  } catch (err) {
    logBillingError('sendEmailChannel', err, { entityType, entity_id: entity?.id, reminderType });
    return { ok: false, error: err.message };
  }
}

async function sendWhatsAppChannel({
  entity,
  entityType,
  reminderType,
  amount,
  paymentLinkUrl,
  anchorDate,
}) {
  const phone =
    entityType === 'tenant'
      ? (entity.manager_phone || entity.contact_phone || entity.phone || null)
      : (entity.phone || entity.waba_phone || null);

  if (!phone) {
    console.warn('[billingReminders] whatsapp skipped — no phone', {
      entityType,
      entity_id: entity?.id,
      reminderType,
    });
    return { ok: true, skipped: true, reason: 'no_phone' };
  }

  const waKey = REMINDER_TYPE_TO_WA[reminderType]?.[entityType];
  if (!waKey) {
    return { ok: false, error: `no_wa_template_for_${reminderType}` };
  }

  const name =
    entityType === 'supplier'
      ? (entity.business_name || entity.name || 'your account')
      : (entity.name || 'your restaurant');

  const params = {
    business_name: name,
    amount,
    anchor_date: toDateKey(anchorDate) || '',
    payment_link: paymentLinkUrl || '—',
  };

  const fallbackText =
    billingReminderEmail({
      entity,
      entityType,
      reminderType,
      amount,
      paymentLinkUrl,
      anchorDate,
    }).text;

  try {
    // Lazy require — supply notify lives under routes/supply (same codebase).
    const { sendSubscriptionWhatsAppTemplate } = require('../routes/supply/notify');
    const result = await sendSubscriptionWhatsAppTemplate({
      entityType,
      templateKey: waKey,
      params,
      toPhone: phone,
      restaurantId: entityType === 'tenant' ? entity.id : null,
      fallbackText,
    });
    if (result.skipped) return { ok: true, skipped: true, reason: result.reason };
    if (!result.ok) return { ok: false, error: result.error || 'whatsapp_failed' };
    return { ok: true, sent: true, fallback: !!result.fallback };
  } catch (err) {
    logBillingError('sendWhatsAppChannel', err, { entityType, entity_id: entity?.id, reminderType });
    return { ok: false, error: err.message };
  }
}

async function processEntitySubscription({ entityType, sub, entity }) {
  const anchor = getCycleAnchor(sub);
  if (!anchor) return { processed: false, reason: 'no_anchor' };

  const relative = daysRelativeToAnchor(anchor);
  const checkpoint = checkpointForRelativeDays(relative);
  if (!checkpoint) return { processed: false, reason: 'no_checkpoint' };

  const cycleAnchor = toDateKey(anchor);
  const entityId = entityType === 'tenant' ? sub.restaurant_id : sub.supplier_id;

  if (await alreadySent({
    entityType,
    entityId,
    reminderType: checkpoint.reminderType,
    cycleAnchor,
  })) {
    return { processed: false, reason: 'already_sent' };
  }

  const amount = Number(sub.final_price ?? sub.base_price ?? 0);
  let paymentLinkUrl = null;
  if (checkpoint.needsPaymentLink) {
    paymentLinkUrl =
      (await loadPendingPaymentLink(entityType, entityId))
      || paymentLinkFor(entityType, entity, sub);
  }

  const graceEndsAt = (() => {
    const key = toDateKey(anchor);
    if (!key) return null;
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + GRACE_PERIOD_DAYS)).toISOString();
  })();

  const emailResult = await sendEmailChannel({
    entity,
    entityType,
    reminderType: checkpoint.reminderType,
    amount,
    paymentLinkUrl,
    anchorDate: anchor,
    graceEndsAt,
  });

  const waResult = await sendWhatsAppChannel({
    entity,
    entityType,
    reminderType: checkpoint.reminderType,
    amount,
    paymentLinkUrl,
    anchorDate: anchor,
  });

  const emailFailed = emailResult.ok === false;
  const waFailed = waResult.ok === false;

  if (emailFailed || waFailed) {
    console.error('[billingReminders] partial/channel failure — NOT marking sent', {
      entityType,
      entity_id: entityId,
      reminder_type: checkpoint.reminderType,
      cycle_anchor: cycleAnchor,
      email: emailResult,
      whatsapp: waResult,
    });
    return { processed: false, reason: 'channel_failure', emailResult, waResult };
  }

  await recordSent({
    entityType,
    entityId,
    subscriptionId: sub.id,
    reminderType: checkpoint.reminderType,
    cycleAnchor,
  });

  if (checkpoint.setOverdue || checkpoint.activateSoftLock) {
    await setOverdueStatus(entityType, sub.id);
  }

  console.log('[billingReminders] sent', {
    entityType,
    entity_id: entityId,
    reminder_type: checkpoint.reminderType,
    cycle_anchor: cycleAnchor,
    soft_locked: isSubscriptionSoftLocked({ ...sub, status: overdueStatusFor(entityType) }),
    email: emailResult,
    whatsapp: waResult,
  });

  return { processed: true, reminderType: checkpoint.reminderType };
}

async function loadTenantTargets() {
  const { data: subs, error } = await supabaseAdmin
    .from('tenant_subscriptions')
    .select('id, restaurant_id, status, trial_ends_at, renews_at, final_price, base_price')
    .in('status', ['trial', 'active', 'past_due']);

  if (error) {
    logBillingError('loadTenantTargets', error);
    return [];
  }
  if (!subs?.length) return [];

  const ids = [...new Set(subs.map((s) => s.restaurant_id))];
  const { data: tenants, error: tErr } = await supabaseAdmin
    .from('tenants')
    .select('id, name, contact_email, email, manager_phone, contact_phone, phone, is_active')
    .in('id', ids)
    .eq('is_active', true);

  if (tErr) {
    logBillingError('loadTenantTargets.tenants', tErr);
    return [];
  }

  const byId = Object.fromEntries((tenants || []).map((t) => [t.id, t]));
  return subs
    .filter((s) => byId[s.restaurant_id])
    .map((s) => ({ entityType: 'tenant', sub: s, entity: byId[s.restaurant_id] }));
}

async function loadSupplierTargets() {
  const { data: subs, error } = await supabaseAdmin
    .from('supplier_subscriptions')
    .select('id, supplier_id, status, trial_ends_at, renews_at, final_price, base_price')
    .in('status', ['trial', 'active', 'overdue']);

  if (error) {
    // Table may not exist until migration runs — log and continue with tenants.
    logBillingError('loadSupplierTargets', error);
    return [];
  }
  if (!subs?.length) return [];

  const ids = [...new Set(subs.map((s) => s.supplier_id))];
  const { data: suppliers, error: sErr } = await supabaseAdmin
    .from('suppliers')
    .select('id, name, business_name, email, phone, waba_phone, is_active')
    .in('id', ids)
    .eq('is_active', true);

  if (sErr) {
    logBillingError('loadSupplierTargets.suppliers', sErr);
    return [];
  }

  const byId = Object.fromEntries((suppliers || []).map((s) => [s.id, s]));
  return subs
    .filter((s) => byId[s.supplier_id])
    .map((s) => ({ entityType: 'supplier', sub: s, entity: byId[s.supplier_id] }));
}

/**
 * Daily job entry point. Parameterized by entity type — one code path.
 * @param {{ entityTypes?: Array<'tenant'|'supplier'> }} [opts]
 */
async function runReminderCheck(opts = {}) {
  const entityTypes = opts.entityTypes || ['tenant', 'supplier'];
  const targets = [];

  if (entityTypes.includes('tenant')) {
    targets.push(...(await loadTenantTargets()));
  }
  if (entityTypes.includes('supplier')) {
    targets.push(...(await loadSupplierTargets()));
  }

  let sent = 0;
  let failed = 0;

  for (const target of targets) {
    try {
      const result = await processEntitySubscription(target);
      if (result.processed) sent += 1;
      if (result.reason === 'channel_failure') failed += 1;
    } catch (err) {
      failed += 1;
      logBillingError('processEntitySubscription', err, {
        entityType: target.entityType,
        entity_id: target.entity?.id,
      });
    }
  }

  console.log('[billingReminders] runReminderCheck done', {
    scanned: targets.length,
    sent,
    failed,
    grace_period_days: GRACE_PERIOD_DAYS,
    entityTypes,
  });

  return { scanned: targets.length, sent, failed };
}

module.exports = {
  runReminderCheck,
  processEntitySubscription,
  CHECKPOINTS,
  GRACE_PERIOD_DAYS,
};
