// src/utils/supplyFormToken.js
// ============================================================================
// Munafe Supply — Signed URL token utility for the public order form.
//
// Token format:  base64url(payload).base64url(HMAC-SHA256 signature)
//
// payload fields:
//   supplier_id  (UUID)
//   client_id    (UUID)
//   expires      (Unix seconds)
//   permanent    (bool)  — if true, token is valid for 30 days and auto-renewable
//
// Token types:
//   Daily    — valid until tonight's ordering cutoff (sent each evening by scheduler)
//   Bookmark — permanent token, 30-day rolling expiry, auto-renewed on load
//
// Environment variable: SUPPLY_FORM_SIGNING_SECRET
// ============================================================================

'use strict';

const crypto = require('crypto');

const SECRET = process.env.SUPPLY_FORM_SIGNING_SECRET || 'dev_form_signing_secret';

if (!process.env.SUPPLY_FORM_SIGNING_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('SUPPLY_FORM_SIGNING_SECRET must be set in production');
}

// ── createFormToken ───────────────────────────────────────────────────────────
/**
 * Create a signed order form token.
 *
 * @param {string}    supplier_id
 * @param {string}    client_id
 * @param {Date|null} valid_until   null for permanent tokens (30d from now)
 * @param {boolean}   permanent     true = bookmark token
 * @returns {string}  token string  (safe for URL paths — no +/= chars)
 */
function createFormToken(supplier_id, client_id, valid_until = null, permanent = false) {
  const expires = valid_until
    ? Math.floor(valid_until.getTime() / 1000)
    : Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

  const payload = JSON.stringify({
    supplier_id,
    client_id,
    expires,
    permanent: !!permanent,
  });

  const b64     = Buffer.from(payload).toString('base64url');
  const sig     = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');

  return `${b64}.${sig}`;
}

// ── validateFormToken ─────────────────────────────────────────────────────────
/**
 * Validate a signed form token.
 *
 * @param {string} token
 * @returns {{ supplier_id, client_id, expires, permanent, expired: bool } | null}
 *   null  → invalid signature or malformed
 *   {..., expired: true }  → valid signature but past expiry (show friendly message)
 *   {..., expired: false } → valid and current
 */
function validateFormToken(token) {
  if (!token || typeof token !== 'string') return null;

  const dotIdx = token.lastIndexOf('.');
  if (dotIdx === -1) return null;

  const b64 = token.slice(0, dotIdx);
  const sig  = token.slice(dotIdx + 1);

  // Constant-time comparison to prevent timing attacks
  let expectedSig;
  try {
    expectedSig = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  } catch {
    return null;
  }

  if (sig.length !== expectedSig.length) return null;

  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  } catch {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload.supplier_id || !payload.client_id || !payload.expires) return null;

  const expired = !payload.permanent && payload.expires < Math.floor(Date.now() / 1000);

  return { ...payload, expired };
}

// ── renewPermanentToken ───────────────────────────────────────────────────────
/**
 * Refresh the expiry on a permanent bookmark token.
 * Called when a client loads the form via /s/b/:token and the token is
 * within 7 days of expiry (rolling renewal).
 *
 * Returns the same token if not close to expiry, or a new one if renewed.
 */
function renewPermanentToken(decoded) {
  if (!decoded.permanent) return null;
  const sevenDays = 7 * 24 * 60 * 60;
  const remaining = decoded.expires - Math.floor(Date.now() / 1000);
  if (remaining > sevenDays) return null; // no renewal needed yet
  return createFormToken(decoded.supplier_id, decoded.client_id, null, true);
}

module.exports = { createFormToken, validateFormToken, renewPermanentToken };
