'use strict';

function exportCategoryLabel(category) {
  const c = String(category || '').trim();
  return c && c !== 'General' ? c : '';
}

function exportTimeSlotLabel(timeSlot) {
  if (!timeSlot || timeSlot === 'all') return '';
  return SLOT_DISPLAY_LABELS[timeSlot] || String(timeSlot).replace(/_/g, ' ');
}

function parseBoolCell(raw, defaultVal = false) {
  if (raw === undefined || raw === null || raw === '') return defaultVal;
  const s = String(raw).toLowerCase().trim();
  return s === 'true' || s === '1' || s === 'yes';
}

const KITCHEN_STATIONS = new Set(['tawa', 'steamer', 'kadai', 'beverages', 'assembly', 'cold', 'sweets_counter', 'packing', 'dispatch']);

function parseKitchenStation(raw) {
  const s = String(raw || 'assembly').toLowerCase().trim();
  return KITCHEN_STATIONS.has(s) ? s : 'assembly';
}

// ── GET /api/catalog/feed/template — JSON for Excel download (manager portal) ─

module.exports = {
  exportCategoryLabel,
  exportTimeSlotLabel,
  parseBoolCell,
  KITCHEN_STATIONS,
  parseKitchenStation,
};
