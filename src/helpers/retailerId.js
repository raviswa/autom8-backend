'use strict';

function normalizeCatalogKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function productMatchKey(name, packSizeLabel) {
  return `${normalizeCatalogKey(name)}|${normalizeCatalogKey(packSizeLabel)}`;
}

function deriveRetailerId({ name, packSizeLabel, existingIds = [] }) {
  const namePart = normalizeCatalogKey(name) || 'ITEM';
  const packPart = normalizeCatalogKey(packSizeLabel);
  const base = [namePart, packPart].filter(Boolean).join('-').slice(0, 90).replace(/-+$/g, '') || 'ITEM';
  const used = new Set((existingIds || []).map((id) => String(id).trim().toUpperCase()));
  if (!used.has(base)) return base;

  let suffix = 2;
  while (used.has(`${base.slice(0, 86)}-${suffix}`)) suffix += 1;
  return `${base.slice(0, 86)}-${suffix}`;
}

module.exports = {
  deriveRetailerId,
  normalizeCatalogKey,
  productMatchKey,
};
