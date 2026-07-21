'use strict';

/**
 * Best-effort Indian PIN code -> state lookup, derived from India Post postal
 * circle prefixes. There is no buyer "state" field captured at checkout today,
 * so this is used only to decide CGST+SGST vs IGST on invoices without adding
 * checkout friction. A few circles legitimately span two states (e.g. 20-28
 * covers both UP and Uttarakhand, 80-85 covers both Bihar and Jharkhand) — we
 * pick the larger/more common state in those cases. When either side of the
 * comparison is unknown, callers should fall back to the pre-existing
 * CGST+SGST behaviour rather than guess.
 */

// Checked first — 3-digit prefixes carve out a smaller state/UT from a
// bigger 2-digit circle.
const PREFIX_RULES_3 = [
  { from: 396, to: 396, state: 'Dadra and Nagar Haveli and Daman and Diu' },
  { from: 403, to: 403, state: 'Goa' },
  { from: 605, to: 605, state: 'Puducherry' },
  { from: 682, to: 682, state: 'Lakshadweep' },
  { from: 737, to: 737, state: 'Sikkim' },
  { from: 744, to: 744, state: 'Andaman and Nicobar Islands' },
  { from: 790, to: 792, state: 'Arunachal Pradesh' },
  { from: 793, to: 794, state: 'Meghalaya' },
  { from: 795, to: 795, state: 'Manipur' },
  { from: 796, to: 796, state: 'Mizoram' },
  { from: 797, to: 798, state: 'Nagaland' },
  { from: 799, to: 799, state: 'Tripura' },
];

const PREFIX_RULES_2 = [
  { from: 11, to: 11, state: 'Delhi' },
  { from: 12, to: 13, state: 'Haryana' },
  { from: 14, to: 15, state: 'Punjab' },
  { from: 16, to: 16, state: 'Chandigarh' },
  { from: 17, to: 17, state: 'Himachal Pradesh' },
  { from: 18, to: 19, state: 'Jammu and Kashmir' },
  { from: 20, to: 28, state: 'Uttar Pradesh' }, // also covers Uttarakhand
  { from: 30, to: 34, state: 'Rajasthan' },
  { from: 36, to: 39, state: 'Gujarat' },
  { from: 40, to: 44, state: 'Maharashtra' },
  { from: 45, to: 48, state: 'Madhya Pradesh' },
  { from: 49, to: 49, state: 'Chhattisgarh' },
  { from: 50, to: 50, state: 'Telangana' },
  { from: 51, to: 53, state: 'Andhra Pradesh' },
  { from: 56, to: 59, state: 'Karnataka' },
  { from: 60, to: 66, state: 'Tamil Nadu' },
  { from: 67, to: 69, state: 'Kerala' },
  { from: 70, to: 74, state: 'West Bengal' },
  { from: 75, to: 77, state: 'Odisha' },
  { from: 78, to: 78, state: 'Assam' },
  { from: 80, to: 85, state: 'Bihar' }, // also covers Jharkhand
];

function stateForPincode(pincode) {
  const digits = String(pincode || '').replace(/\D/g, '');
  if (digits.length !== 6) return null;
  const p3 = parseInt(digits.slice(0, 3), 10);
  const p2 = parseInt(digits.slice(0, 2), 10);
  const rule3 = PREFIX_RULES_3.find((r) => p3 >= r.from && p3 <= r.to);
  if (rule3) return rule3.state;
  const rule2 = PREFIX_RULES_2.find((r) => p2 >= r.from && p2 <= r.to);
  return rule2 ? rule2.state : null;
}

const STATE_NAME_ALIASES = {
  orissa: 'odisha',
  pondicherry: 'puducherry',
  uttaranchal: 'uttarakhand',
  'new delhi': 'delhi',
  ncr: 'delhi',
  tamilnadu: 'tamil nadu',
};

function normalizeStateName(name) {
  const raw = String(name || '').toLowerCase().trim().replace(/\s+/g, ' ');
  return STATE_NAME_ALIASES[raw] || raw;
}

/**
 * Returns true/false when both states are known, or null when either side
 * is unknown (caller should default to the existing intra-state behaviour).
 */
function isInterState(sellerStateName, buyerPincode) {
  const buyerState = stateForPincode(buyerPincode);
  if (!sellerStateName || !buyerState) return null;
  return normalizeStateName(sellerStateName) !== normalizeStateName(buyerState);
}

/** Pulls a 6-digit PIN out of common order field names or a free-text address. */
function resolveOrderPincode(order) {
  if (!order) return null;
  const direct = order.delivery_pincode || order.customer_pincode || order.pincode || order.shipping_pincode;
  if (direct) {
    const digits = String(direct).replace(/\D/g, '');
    if (digits.length === 6) return digits;
  }
  const addressFields = [order.delivery_address, order.shipping_address, order.customer_address, order.address];
  for (const addr of addressFields) {
    if (!addr) continue;
    const match = String(addr).match(/\b\d{6}\b/);
    if (match) return match[0];
  }
  return null;
}

module.exports = { stateForPincode, normalizeStateName, isInterState, resolveOrderPincode };
