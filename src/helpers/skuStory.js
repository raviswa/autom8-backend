'use strict';

/**
 * Story share kit as SVG (1080×1920). Open in browser → screenshot / export PNG.
 * No canvas/sharp dependency.
 */

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSkuStorySvg({
  brand = 'Kitchen',
  productName = 'New drop',
  price = null,
  packLabel = null,
  tagline = 'Homemade · small batch',
  shopHint = 'Order on WhatsApp',
} = {}) {
  const priceLine = price != null ? `₹${Math.round(Number(price)).toLocaleString('en-IN')}` : '';
  const pack = packLabel ? String(packLabel) : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a2e1a"/>
      <stop offset="100%" stop-color="#3d2914"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <text x="540" y="220" text-anchor="middle" fill="#f5e6c8" font-family="Georgia, serif" font-size="42" letter-spacing="4">${escapeXml(brand).toUpperCase()}</text>
  <text x="540" y="820" text-anchor="middle" fill="#fff8e7" font-family="Georgia, serif" font-size="64">${escapeXml(productName)}</text>
  ${pack ? `<text x="540" y="900" text-anchor="middle" fill="#d4b896" font-family="sans-serif" font-size="32">${escapeXml(pack)}</text>` : ''}
  ${priceLine ? `<text x="540" y="1020" text-anchor="middle" fill="#f0c14b" font-family="sans-serif" font-size="56" font-weight="700">${escapeXml(priceLine)}</text>` : ''}
  <text x="540" y="1480" text-anchor="middle" fill="#e8d5b5" font-family="sans-serif" font-size="28">${escapeXml(tagline)}</text>
  <text x="540" y="1680" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="36">${escapeXml(shopHint)}</text>
</svg>`;
}

module.exports = { buildSkuStorySvg };
