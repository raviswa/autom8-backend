'use strict';

/**
 * Calendar helpers in Asia/Kolkata (IST).
 * Avoid Date#toISOString().slice(0,10) for business dates — that is UTC and
 * shifts the calendar day for evening IST times.
 */

const DEFAULT_TZ = 'Asia/Kolkata';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function istTodayYmd(timeZone = DEFAULT_TZ) {
  // en-CA → YYYY-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone });
}

function istParts(timeZone = DEFAULT_TZ, date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = String(parts.weekday || '').slice(0, 3); // Mon, Tue, …
  return {
    ymd,
    weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** Add whole calendar days to a YYYY-MM-DD string (Gregorian). */
function addCalendarDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + Number(days || 0)));
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function weekdayShortForYmd(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  // Noon UTC avoids DST edge cases; weekday for a pure calendar date is stable enough for IST business use.
  const utc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return DAY_NAMES[utc.getUTCDay()];
}

/**
 * Next delivery date for a client.
 * Includes today (offset 0) when today is a delivery day — Orders list is
 * keyed by delivery_date, so skipping today looked like a +24h bug.
 */
function nextSupplyDeliveryDate(deliveryDays = [], timeZone = DEFAULT_TZ) {
  const today = istTodayYmd(timeZone);
  const allowed = Array.isArray(deliveryDays) && deliveryDays.length
    ? deliveryDays
    : DAY_NAMES;

  for (let i = 0; i <= 7; i += 1) {
    const ymd = addCalendarDaysYmd(today, i);
    const day = weekdayShortForYmd(ymd);
    if (allowed.includes(day)) return ymd;
  }
  return today;
}

function istTomorrowYmd(timeZone = DEFAULT_TZ) {
  return addCalendarDaysYmd(istTodayYmd(timeZone), 1);
}

module.exports = {
  DEFAULT_TZ,
  DAY_NAMES,
  istTodayYmd,
  istParts,
  addCalendarDaysYmd,
  weekdayShortForYmd,
  nextSupplyDeliveryDate,
  istTomorrowYmd,
};
