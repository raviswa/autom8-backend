'use strict';

function normalizeSlotArray(input) {
  const ALLOWED = new Set(['tiffin', 'lunch', 'dinner', 'anytime']);
  const list = Array.isArray(input) ? input : [];
  const clean = [...new Set(list.map(s => String(s || '').toLowerCase().trim()).filter(Boolean))]
    .filter(s => ALLOWED.has(s));
  if (!clean.length) return ['anytime'];
  // anytime = all day; never combine with specific meal slots
  if (clean.includes('anytime')) return ['anytime'];
  return clean;
}

module.exports = { normalizeSlotArray };
