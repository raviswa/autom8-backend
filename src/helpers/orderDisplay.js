'use strict';

/**
 * Kitchen-facing order ID — numeric only (never booking UUID hex tails).
 * ORD-153-2228b7cf → 153 · ORD-153-R2 → 153-2 · ORD-WA-1722… → last digits
 *
 * Keep in sync with autom8-frontend-main/src/helpers/orderDisplay.js
 */

function formatKitchenOrderNo(orderNumber, tokenNumber) {
  const raw = String(orderNumber || '').trim();
  const tokenDigits = String(tokenNumber || '').replace(/^T-/i, '').replace(/\D/g, '');

  // ORD-{token}-R{n} (reorder rounds)
  let m = raw.match(/^ORD-([^/-]+)-R(\d+)$/i);
  if (m) {
    const base = String(m[1]).replace(/\D/g, '');
    if (base) return `${base}-${m[2]}`;
  }

  // ORD-{token} or ORD-{token}-{hexBookingId}
  m = raw.match(/^ORD-([^/-]+)(?:-[a-f0-9]{6,})?$/i);
  if (m && !/^(B|WA)$/i.test(m[1])) {
    const base = String(m[1]).replace(/\D/g, '');
    if (base) return base;
  }

  // ORD-B-{hex} → decimal digits from hex fragment
  m = raw.match(/^ORD-B-([a-f0-9]+)$/i);
  if (m) {
    try {
      return BigInt(`0x${m[1]}`).toString().slice(-8);
    } catch (_) { /* fall through */ }
  }

  // ORD-WA-{timestamp} or ORD-{timestamp}
  m = raw.match(/^ORD-(?:WA-)?(\d+)$/i);
  if (m) return m[1].slice(-8);

  if (tokenDigits) return tokenDigits;

  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 3) return digits.slice(-8);
  return '—';
}

module.exports = { formatKitchenOrderNo };
