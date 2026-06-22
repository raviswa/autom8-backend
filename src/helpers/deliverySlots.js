'use strict';

/**
 * Scheduled door delivery slot validation (IST) — mirrors chat/tools/delivery_slots.py.
 */

const IST = 'Asia/Kolkata';

const MIN_BUFFER_HOURS = Math.max(
  1,
  parseInt(process.env.SCHEDULED_DELIVERY_MIN_BUFFER_HOURS || '2', 10),
);
const SLOT_GRANULARITY_MINUTES = Math.max(
  15,
  parseInt(process.env.SCHEDULED_DELIVERY_SLOT_MINUTES || '30', 10),
);
const MAX_DAYS_AHEAD = Math.max(
  1,
  parseInt(process.env.SCHEDULED_DELIVERY_MAX_DAYS || '7', 10),
);

// Keep in sync with catalog.js / kitchen_hours.py
const OPERATING_START = 6;
const OPERATING_END = 24;

/** Current instant — use istDateParts() for IST wall-clock fields. */
function nowInIst() {
  return new Date();
}

function pad2(n) {
  return String(n).padStart(2, '0');
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
  let hour = get('hour');
  if (hour === 24) hour = 0;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
  };
}

/** IST wall-clock → UTC instant (handles +05:30 correctly on UTC servers). */
function istInstantFromParts({ year, month, day, hour, minute }) {
  const iso = `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00+05:30`;
  return new Date(iso);
}

function addIstCalendarDays(instant, days) {
  const { year, month, day } = istDateParts(instant);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function roundUpToSlot(instant) {
  let { year, month, day, hour, minute } = istDateParts(instant);

  if (SLOT_GRANULARITY_MINUTES === 60) {
    if (minute !== 0) {
      hour += 1;
      minute = 0;
    }
  } else {
    const rem = minute % SLOT_GRANULARITY_MINUTES;
    if (rem !== 0) {
      minute += SLOT_GRANULARITY_MINUTES - rem;
      if (minute >= 60) {
        hour += Math.floor(minute / 60);
        minute %= 60;
      }
    }
  }

  if (hour >= 24) {
    const next = addIstCalendarDays(istInstantFromParts({ year, month, day, hour: 0, minute: 0 }), 1);
    year = next.year;
    month = next.month;
    day = next.day;
    hour -= 24;
  }

  return istInstantFromParts({ year, month, day, hour, minute });
}

function earliestValidSlot(now = nowInIst()) {
  const raw = new Date(now.getTime() + MIN_BUFFER_HOURS * 60 * 60 * 1000);
  return roundUpToSlot(raw);
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
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function latestBookableDateKey(now = nowInIst()) {
  const shifted = addIstCalendarDays(now, MAX_DAYS_AHEAD);
  return `${shifted.year}-${pad2(shifted.month)}-${pad2(shifted.day)}`;
}

function validateScheduledDeliverySlot(requestedISO, now = nowInIst()) {
  const requested = new Date(requestedISO);
  if (Number.isNaN(requested.getTime())) {
    return { valid: false, reason: 'invalid', message: 'Invalid delivery time' };
  }

  if (requested.getTime() <= now.getTime()) {
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
    if (requested.getTime() < earliest.getTime()) {
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
