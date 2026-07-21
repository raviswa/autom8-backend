'use strict';

/**
 * Time-limited percent discounts on menu_items.
 * Base list price stays in `price`; effective/sale price is derived here.
 */

function clampPercent(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 100) return 100;
  return Math.round(n * 100) / 100;
}

function parseEndsAt(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {object} item - menu row with price, discount_percent, discount_ends_at
 * @param {Date} [now]
 * @returns {{
 *   discount_active: boolean,
 *   discount_percent: number|null,
 *   discount_ends_at: string|null,
 *   discount_days_left: number|null,
 *   discount_hours_left: number|null,
 *   list_price: number,
 *   effective_price: number,
 * }}
 */
function deriveMenuDiscount(item, now = new Date()) {
  const listPrice = Math.max(0, Number(item?.price || 0));
  const pct = clampPercent(item?.discount_percent);
  const endsAt = parseEndsAt(item?.discount_ends_at);
  const active = !!(pct && endsAt && endsAt.getTime() > now.getTime());

  if (!active) {
    return {
      discount_active: false,
      discount_percent: pct,
      discount_ends_at: endsAt ? endsAt.toISOString() : (item?.discount_ends_at || null),
      discount_days_left: null,
      discount_hours_left: null,
      list_price: listPrice,
      effective_price: listPrice,
    };
  }

  const msLeft = endsAt.getTime() - now.getTime();
  const hoursLeft = Math.max(1, Math.ceil(msLeft / (60 * 60 * 1000)));
  const daysLeft = Math.max(1, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
  const effective = Math.max(0, Math.round(listPrice * (1 - pct / 100)));

  return {
    discount_active: true,
    discount_percent: pct,
    discount_ends_at: endsAt.toISOString(),
    discount_days_left: daysLeft,
    discount_hours_left: hoursLeft,
    list_price: listPrice,
    effective_price: effective,
  };
}

/**
 * Build DB patch from owner input. Does not trust client-supplied ends_at.
 * @param {{ discount_percent?: any, duration_days?: any, clear?: boolean }} body
 * @param {Date} [now]
 */
function buildDiscountPatch(body = {}, now = new Date()) {
  const clear = body.clear === true
    || body.discount_percent === null
    || body.discount_percent === ''
    || Number(body.discount_percent) === 0;

  if (clear) {
    return {
      patch: { discount_percent: null, discount_ends_at: null, updated_at: now.toISOString() },
      cleared: true,
    };
  }

  const pct = clampPercent(body.discount_percent);
  if (!pct) {
    return { error: 'discount_percent must be between 1 and 100' };
  }

  const days = Math.floor(Number(body.duration_days));
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return { error: 'duration_days must be an integer from 1 to 365' };
  }

  const endsAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  return {
    patch: {
      discount_percent: pct,
      discount_ends_at: endsAt.toISOString(),
      updated_at: now.toISOString(),
    },
    cleared: false,
    duration_days: days,
  };
}

function discountLabel(discount) {
  if (!discount?.discount_active) return '';
  const pct = discount.discount_percent;
  if (discount.discount_days_left <= 1 && discount.discount_hours_left != null) {
    return `${pct}% off · ${discount.discount_hours_left}h left`;
  }
  const d = discount.discount_days_left;
  return `${pct}% off for the next ${d} day${d === 1 ? '' : 's'}`;
}

module.exports = {
  clampPercent,
  deriveMenuDiscount,
  buildDiscountPatch,
  discountLabel,
};
