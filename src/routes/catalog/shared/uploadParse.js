'use strict';

const {
  KITCHEN_STATIONS,
  parseKitchenStation,
  resolveKitchenStation,
  isReadymadeCategory,
} = require('../../../helpers/kdsQueue');

function exportCategoryLabel(category) {
  const c = String(category || '').trim();
  return c && c !== 'General' ? c : '';
}

const SLOT_DISPLAY_LABELS = Object.freeze({
  breakfast: 'Breakfast',
  brunch: 'Brunch',
  lunch: 'Lunch',
  snacks: 'Snacks',
  dinner: 'Dinner',
  late_night: 'Late Night',
});

function exportTimeSlotLabel(timeSlot) {
  if (!timeSlot || timeSlot === 'all') return '';
  return SLOT_DISPLAY_LABELS[timeSlot] || String(timeSlot).replace(/_/g, ' ');
}

function parseBoolCell(raw, defaultVal = false) {
  if (raw === undefined || raw === null || raw === '') return defaultVal;
  const s = String(raw).toLowerCase().trim();
  return s === 'true' || s === '1' || s === 'yes';
}

// ── GET /api/catalog/feed/template — JSON for Excel download (manager portal) ─

module.exports = {
  exportCategoryLabel,
  exportTimeSlotLabel,
  parseBoolCell,
  KITCHEN_STATIONS,
  parseKitchenStation,
  resolveKitchenStation,
  isReadymadeCategory,
};
