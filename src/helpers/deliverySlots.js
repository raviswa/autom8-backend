'use strict';

/**
 * Scheduled door delivery slot validation (IST) — mirrors chat/tools/delivery_slots.py.
 */

const IST = 'Asia/Kolkata';

const MIN_BUFFER_HOURS = Math.max(
  1,
  parseInt(process.env.SCHEDULED_DELIVERY_MIN_BUFFER_HOURS || '3', 10),
);
const SLOT_GRANULARITY_MINUTES = Math.max(
  15,
  parseInt(process.env.SCHEDULED_DELIVERY_SLOT_MINUTES || '60', 10),
);
const MAX_DAYS_AHEAD = Math.max(
  1,
  parseInt(process.env.SCHEDULED_DELIVERY_MAX_DAYS || '7', 10),
);

// Keep in sync with catalog.js / kitchen_hours.py
const OPERATING_START = 6;
const OPERATING_END = 24;

function nowInIst() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: IST }));
}

function roundUpToSlot(date) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  if (SLOT_GRANULARITY_MINUTES === 60) {
    if (d.getMinutes() === 0) return d;
    d.setMinutes(0);
    d.setHours(d.getHours() + 1);
    return d;
  }
  const rem = d.getMinutes() % SLOT_GRANULARITY_MINUTES;
  if (rem === 0) return d;
  d.setMinutes(d.getMinutes() + (SLOT_GRANULARITY_MINUTES - rem));
  return d;
}

function earliestValidSlot(now = nowInIst()) {
  const raw = new Date(now.getTime() + MIN_BUFFER_HOURS * 60 * 60 * 1000);
  return roundUpToSlot(raw);
}

function istDateParts(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parseInt(parts.find((p) => p.type === type)?.value || '0', 10);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
  };
}

function withinOperatingWindow(requested) {
  const { hour } = istDateParts(requested);
  if (hour < OPERATING_START) return false;
  if (OPERATING_END >= 24) return true;
  return hour < OPERATING_END;
}

function sameIstDay(a, b) {
  const pa = istDateParts(a);
  const pb = istDateParts(b);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

function istDateKey(d) {
  const { year, month, day } = istDateParts(d);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function latestBookableDateKey(now = nowInIst()) {
  const d = new Date(now);
  d.setDate(d.getDate() + MAX_DAYS_AHEAD);
  return istDateKey(d);
}

function validateScheduledDeliverySlot(requestedISO, now = nowInIst()) {
  const requested = new Date(requestedISO);
  if (Number.isNaN(requested.getTime())) {
    return { valid: false, reason: 'invalid', message: 'Invalid delivery time' };
  }

  if (requested <= now) {
    return { valid: false, reason: 'past', message: 'Selected time is in the past' };
  }

  if (istDateKey(requested) > latestBookableDateKey(now)) {
    return {
      valid: false,
      reason: 'too_far',
      message: `We can only schedule up to ${MAX_DAYS_AHEAD} days ahead`,
    };
  }

  if (!withinOperatingWindow(requested)) {
    return {
      valid: false,
      reason: 'window',
      message: `Delivery slots are between ${OPERATING_START}:00 and midnight IST`,
    };
  }

  if (sameIstDay(requested, now)) {
    const earliest = earliestValidSlot(now);
    if (requested < earliest) {
      return {
        valid: false,
        reason: 'buffer',
        message: `Minimum ${MIN_BUFFER_HOURS}h advance notice required (next slot: ${earliest.toLocaleString('en-IN', { timeZone: IST, dateStyle: 'medium', timeStyle: 'short' })})`,
      };
    }
  }

  return { valid: true };
}

module.exports = {
  MIN_BUFFER_HOURS,
  MAX_DAYS_AHEAD,
  validateScheduledDeliverySlot,
  earliestValidSlot,
  latestBookableDateKey,
  buildFlowCalendarData: (now = nowInIst()) => ({
    min_date: istDateKey(earliestValidSlot(now)),
    max_date: latestBookableDateKey(now),
  }),
};
