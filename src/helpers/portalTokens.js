'use strict';

const IST = 'Asia/Kolkata';

/** IST calendar month key for token period, e.g. 2506 (June 2026). */
function portalTokenMonthKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '00';
  return `${get('year').slice(-2)}${get('month')}`;
}

/** Canonical walk_in_tokens.id — unique across all time. */
function buildPortalTokenId(seq, date = new Date()) {
  const yymm = portalTokenMonthKey(date);
  return `T-${yymm}-${String(seq).padStart(3, '0')}`;
}

/**
 * Kitchen / customer facing label — T-125 within the current IST month,
 * full id for prior months to avoid ambiguity.
 */
function formatTokenDisplay(tokenId, date = new Date()) {
  const raw = String(tokenId || '').trim();
  const monthly = raw.match(/^T-(\d{4})-(\d+)$/i);
  if (monthly) {
    const [, yymm, num] = monthly;
    const n = parseInt(num, 10);
    if (yymm === portalTokenMonthKey(date)) {
      return `T-${n}`;
    }
    return `T-${n} (${yymm.slice(0, 2)}/${yymm.slice(2)})`;
  }
  return raw || '—';
}

/** Parse monthly token id into { yymm, seq } or null. */
function parseMonthlyTokenId(tokenId) {
  const m = String(tokenId || '').trim().match(/^T-(\d{4})-(\d+)$/i);
  if (!m) return null;
  return { yymm: m[1], seq: parseInt(m[2], 10) };
}

module.exports = {
  portalTokenMonthKey,
  buildPortalTokenId,
  formatTokenDisplay,
  parseMonthlyTokenId,
};
