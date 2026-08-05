'use strict';

/**
 * Refill WhatsApp reminder scheduler.
 *
 * reminder_due_at formula (set at purchase in refillCycles.js):
 *   purchased_at + days_to_empty - refill_lead_time_days - refill_safety_buffer_days
 *   (floored to purchased_at + 1 day).
 *
 * Snooze loop:
 *   Customer taps "Remind in 3/7 days" → status=snoozed, snooze_until=now+N.
 *   When snooze_until <= now, this worker sends again (same 3-button CTA).
 *   After a successful send: reminder_count++, last_reminded_at=now, status=reminded,
 *   and if reminder_count < 3 we schedule a follow-up reminder_due_at = now + 3 days
 *   (status stays reminded until due, then re-queried). Max 3 sends → expired.
 *
 * Session window:
 *   Interactive reply buttons only work inside Meta's 24h customer-care window.
 *   This codebase has no shared "inside session window?" helper for freeform sends
 *   (billing uses approved templates; kitchen reminders send freeform without a check).
 *   V1 sends buttons via sendWhatsAppInteractive and logs failures — outside-window
 *   sends will fail until an approved refill template exists.
 */

const { supabaseAdmin } = require('../config/supabase');
const { sendRefillReminderButtons } = require('./whatsapp');

const FOLLOW_UP_DAYS = 3;
const MAX_REMINDERS = 3;
const BATCH_LIMIT = 40;

async function processDueRefillReminders() {
  const nowIso = new Date().toISOString();
  let sent = 0;
  let expired = 0;
  let skipped = 0;

  // Due pending / reminded follow-ups
  const { data: dueRows, error: dueErr } = await supabaseAdmin
    .from('refill_cycles')
    .select(
      'id, restaurant_id, menu_item_id, retailer_id, item_name, customer_phone, '
      + 'days_to_empty, reminder_count, status, reminder_due_at, snooze_until',
    )
    .in('status', ['pending', 'reminded'])
    .lte('reminder_due_at', nowIso)
    .order('reminder_due_at', { ascending: true })
    .limit(BATCH_LIMIT);

  if (dueErr) {
    console.warn('[refillReminders] due query:', dueErr.message);
  }

  // Due snoozes
  const { data: snoozeRows, error: snoozeErr } = await supabaseAdmin
    .from('refill_cycles')
    .select(
      'id, restaurant_id, menu_item_id, retailer_id, item_name, customer_phone, '
      + 'days_to_empty, reminder_count, status, reminder_due_at, snooze_until',
    )
    .eq('status', 'snoozed')
    .lte('snooze_until', nowIso)
    .order('snooze_until', { ascending: true })
    .limit(BATCH_LIMIT);

  if (snoozeErr) {
    console.warn('[refillReminders] snooze query:', snoozeErr.message);
  }

  const seen = new Set();
  const rows = [];
  for (const row of [...(dueRows || []), ...(snoozeRows || [])]) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }

  for (const cycle of rows) {
    try {
      const count = Number(cycle.reminder_count || 0) || 0;
      if (count >= MAX_REMINDERS) {
        await supabaseAdmin
          .from('refill_cycles')
          .update({ status: 'expired', updated_at: nowIso })
          .eq('id', cycle.id)
          .eq('restaurant_id', cycle.restaurant_id);
        expired += 1;
        continue;
      }

      const { data: tenant } = await supabaseAdmin
        .from('tenants')
        .select('id, refill_reminders_enabled')
        .eq('id', cycle.restaurant_id)
        .maybeSingle();

      if (!tenant?.refill_reminders_enabled) {
        skipped += 1;
        continue;
      }

      let itemName = cycle.item_name || 'your item';
      let daysToEmpty = Number(cycle.days_to_empty) || null;
      if (cycle.menu_item_id) {
        const { data: menu } = await supabaseAdmin
          .from('menu_items')
          .select('name, days_to_empty, is_available')
          .eq('id', cycle.menu_item_id)
          .eq('restaurant_id', cycle.restaurant_id)
          .maybeSingle();
        if (menu) {
          if (menu.name) itemName = menu.name;
          if (menu.days_to_empty != null) daysToEmpty = Number(menu.days_to_empty) || daysToEmpty;
          if (menu.is_available === false) {
            skipped += 1;
            continue;
          }
        }
      }

      const ok = await sendRefillReminderButtons({
        toNumber: cycle.customer_phone,
        restaurantId: cycle.restaurant_id,
        cycleId: cycle.id,
        itemName,
        daysToEmpty: daysToEmpty || cycle.days_to_empty,
      });

      if (!ok) {
        console.warn(`[refillReminders] send failed cycle=${cycle.id}`);
        skipped += 1;
        continue;
      }

      const nextCount = count + 1;
      const patch = {
        reminder_count: nextCount,
        last_reminded_at: nowIso,
        status: nextCount >= MAX_REMINDERS ? 'expired' : 'reminded',
        snooze_until: null,
        updated_at: nowIso,
      };
      if (nextCount < MAX_REMINDERS) {
        patch.reminder_due_at = new Date(
          Date.now() + FOLLOW_UP_DAYS * 86400000,
        ).toISOString();
      }

      await supabaseAdmin
        .from('refill_cycles')
        .update(patch)
        .eq('id', cycle.id)
        .eq('restaurant_id', cycle.restaurant_id);

      if (nextCount >= MAX_REMINDERS) expired += 1;
      else sent += 1;
    } catch (err) {
      console.warn(`[refillReminders] cycle ${cycle.id}:`, err.message);
    }
  }

  return { sent, expired, skipped, scanned: rows.length };
}

function startRefillReminderScheduler() {
  const tick = async () => {
    try {
      const result = await processDueRefillReminders();
      if (result.scanned > 0) {
        console.log(
          `[refillReminders] scanned=${result.scanned} sent=${result.sent} `
          + `expired=${result.expired} skipped=${result.skipped}`,
        );
      }
    } catch (err) {
      console.error('[refillReminders] Scheduler error:', err.message);
    }
  };

  setTimeout(() => { void tick(); }, 2 * 60 * 1000);
  setInterval(() => { void tick(); }, 45 * 60 * 1000);
  console.log('🔁 Refill reminder scheduler started (every 45 min)');
}

module.exports = {
  startRefillReminderScheduler,
  processDueRefillReminders,
};
