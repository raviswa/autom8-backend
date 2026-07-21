'use strict';

/**
 * Story share kit as SVG (1080×1920). Open in browser → screenshot / export PNG.
 * No canvas/sharp dependency. Discount / special promo fields bake into the creative
 * because Instagram Stories ignore API captions.
 */

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapLines(text, maxChars = 28, maxLines = 3) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines;
}

function buildSkuStorySvg({
  brand = 'Kitchen',
  productName = 'New drop',
  price = null,
  compareAtPrice = null,
  packLabel = null,
  tagline = 'Homemade · small batch',
  shopHint = 'Order on WhatsApp',
  promoHeadline = null,
  promoSubcopy = null,
  discountPercent = null,
  isSpecial = false,
} = {}) {
  const sale = price != null ? `₹${Math.round(Number(price)).toLocaleString('en-IN')}` : '';
  const was = compareAtPrice != null && Number(compareAtPrice) > Number(price || 0)
    ? `₹${Math.round(Number(compareAtPrice)).toLocaleString('en-IN')}`
    : '';
  const pack = packLabel ? String(packLabel) : '';
  const badge = discountPercent
    ? `${Math.round(Number(discountPercent))}% OFF`
    : (isSpecial ? "TODAY'S SPECIAL" : (promoHeadline || ''));
  const nameLines = wrapLines(productName, 22, 2);
  const subLines = wrapLines(promoSubcopy || tagline, 32, 2);

  const nameSvg = nameLines.map((line, i) => (
    `<text x="540" y="${820 + i * 72}" text-anchor="middle" fill="#fff8e7" font-family="Georgia, serif" font-size="58">${escapeXml(line)}</text>`
  )).join('\n  ');

  const subSvg = subLines.map((line, i) => (
    `<text x="540" y="${1480 + i * 40}" text-anchor="middle" fill="#e8d5b5" font-family="sans-serif" font-size="28">${escapeXml(line)}</text>`
  )).join('\n  ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a2e1a"/>
      <stop offset="100%" stop-color="#3d2914"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <text x="540" y="180" text-anchor="middle" fill="#f5e6c8" font-family="Georgia, serif" font-size="40" letter-spacing="4">${escapeXml(brand).toUpperCase()}</text>
  ${badge ? `
  <rect x="290" y="240" width="500" height="70" rx="35" fill="#c2410c"/>
  <text x="540" y="286" text-anchor="middle" fill="#fff7ed" font-family="sans-serif" font-size="34" font-weight="700">${escapeXml(badge)}</text>
  ` : ''}
  ${nameSvg}
  ${pack ? `<text x="540" y="980" text-anchor="middle" fill="#d4b896" font-family="sans-serif" font-size="32">${escapeXml(pack)}</text>` : ''}
  ${sale ? `<text x="540" y="1080" text-anchor="middle" fill="#f0c14b" font-family="sans-serif" font-size="64" font-weight="700">${escapeXml(sale)}</text>` : ''}
  ${was ? `<text x="540" y="1145" text-anchor="middle" fill="#a8a29e" font-family="sans-serif" font-size="28" text-decoration="line-through">${escapeXml(was)}</text>` : ''}
  ${subSvg}
  <text x="540" y="1680" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="34">${escapeXml(shopHint)}</text>
</svg>`;
}

module.exports = { buildSkuStorySvg };
