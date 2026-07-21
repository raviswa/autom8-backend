'use strict';

/**
 * @deprecated Use src/helpers/billingReminders.js runReminderCheck().
 * Kept so any old require() paths keep working.
 */

const { runReminderCheck, GRACE_PERIOD_DAYS } = require('./billingReminders');

async function runSubscriptionReminderEmails() {
  return runReminderCheck({ entityTypes: ['tenant'] });
}

module.exports = {
  runSubscriptionReminderEmails,
  GRACE_DAYS: GRACE_PERIOD_DAYS,
  TRIAL_REMINDER_DAYS: [7, 3],
};
