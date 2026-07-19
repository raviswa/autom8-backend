'use strict';

/**
 * Shared SaaS subscription access rules (tenants + suppliers).
 *
 * Soft-lock condition (single vocabulary for reminders + future enforcement):
 *   daysPast(cycleAnchor) >= GRACE_PERIOD_DAYS
 *   where cycleAnchor = trial_ends_at if status==='trial', else renews_at
 *
 * Status strings set by the reminder job when unpaid:
 *   tenant   → 'past_due'  (existing tenant_subscriptions enum)
 *   supplier → 'overdue'   (supplier_subscriptions vocabulary)
 *
 * Soft-lock does NOT require status alone — date math is authoritative so a
 * missed status update cannot leave an account unlocked past grace.
 */

const GRACE_PERIOD_DAYS = Math.max(
  1,
  parseInt(process.env.SUBSCRIPTION_GRACE_PERIOD_DAYS || '15', 10) || 15,
);

const LAPSED_ERROR = 'subscription_lapsed';

/** Status written at T+0 / T+15 when unpaid — matches each table's vocabulary. */
const OVERDUE_STATUS = {
  tenant: 'past_due',
  supplier: 'overdue',
};

const CHECKPOINTS = {
  ending_soon: { relativeDays: -7, reminderType: 'ending_soon', needsPaymentLink: false },
  ending_soon_final: { relativeDays: -3, reminderType: 'ending_soon_final', needsPaymentLink: true },
  due_today: { relativeDays: 0, reminderType: 'due_today', needsPaymentLink: true, setOverdue: true },
  overdue_1: { relativeDays: 5, reminderType: 'overdue_1', needsPaymentLink: true },
  overdue_2: { relativeDays: 10, reminderType: 'overdue_2', needsPaymentLink: true, softLockWarning: true },
  grace_expired: {
    relativeDays: GRACE_PERIOD_DAYS,
    reminderType: 'grace_expired',
    needsPaymentLink: true,
    activateSoftLock: true,
  },
};

function summarizeError(error) {
  if (!error) return null;
  return {
    message: error.message || null,
    details: error.details || null,
    hint: error.hint || null,
    code: error.code || null,
  };
}

/** Calendar date YYYY-MM-DD in Asia/Kolkata. */
function istDateKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function toDateKey(isoOrDate) {
  if (!isoOrDate) return null;
  if (typeof isoOrDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(isoOrDate)) {
    return isoOrDate;
  }
  const d = new Date(isoOrDate);
  if (!Number.isFinite(d.getTime())) return null;
  return istDateKey(d);
}

/**
 * Days relative to cycle anchor, measured in IST calendar days.
 * Negative = before anchor (T-7 → -7), 0 = due today, positive = days past (T+5 → 5).
 */
function daysRelativeToAnchor(anchorIso, now = new Date()) {
  const anchorKey = toDateKey(anchorIso);
  const todayKey = istDateKey(now);
  if (!anchorKey || !todayKey) return null;

  const [ay, am, ad] = anchorKey.split('-').map(Number);
  const [ty, tm, td] = todayKey.split('-').map(Number);
  const anchorUtc = Date.UTC(ay, am - 1, ad);
  const todayUtc = Date.UTC(ty, tm - 1, td);
  return Math.round((todayUtc - anchorUtc) / (24 * 60 * 60 * 1000));
}

function getCycleAnchor(sub) {
  if (!sub) return null;
  if (sub.status === 'trial') return sub.trial_ends_at || null;
  return sub.renews_at || sub.trial_ends_at || null;
}

/**
 * Soft-lock is active when the account is at/past grace expiry.
 * Used by billing reminders (grace_expired) and supplyAuth / feature_gate.
 */
function isSubscriptionSoftLocked(sub, now = new Date()) {
  if (!sub) return false;
  if (sub.status === 'cancelled') return true;
  const anchor = getCycleAnchor(sub);
  if (!anchor) return false;
  const relative = daysRelativeToAnchor(anchor, now);
  if (relative == null) return false;
  return relative >= GRACE_PERIOD_DAYS;
}

function buildLapsedPayload(sub = {}) {
  const anchor = getCycleAnchor(sub);
  const graceEnds = anchor
    ? (() => {
        const key = toDateKey(anchor);
        const [y, m, d] = key.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d + GRACE_PERIOD_DAYS));
        return dt.toISOString();
      })()
    : null;

  return {
    error: LAPSED_ERROR,
    message:
      'Subscription expired. Please renew to create new orders or send campaigns. '
      + 'You can still view history and complete payments.',
    grace_ends_at: graceEnds,
    renews_at: sub.renews_at || null,
    trial_ends_at: sub.trial_ends_at || null,
    status: sub.status || null,
  };
}

function checkpointForRelativeDays(relativeDays) {
  if (relativeDays == null) return null;
  for (const cp of Object.values(CHECKPOINTS)) {
    if (cp.relativeDays === relativeDays) return cp;
  }
  return null;
}

function overdueStatusFor(entityType) {
  return OVERDUE_STATUS[entityType] || 'past_due';
}

module.exports = {
  GRACE_PERIOD_DAYS,
  LAPSED_ERROR,
  OVERDUE_STATUS,
  CHECKPOINTS,
  summarizeError,
  istDateKey,
  toDateKey,
  daysRelativeToAnchor,
  getCycleAnchor,
  isSubscriptionSoftLocked,
  buildLapsedPayload,
  checkpointForRelativeDays,
  overdueStatusFor,
};
