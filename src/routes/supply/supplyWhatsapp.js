// src/helpers/supplyWhatsapp.js
// ============================================================================
// Munafe Supply — WhatsApp send engine
//
// Supplies have their OWN WhatsApp Business Account credentials stored on the
// suppliers row (waba_phone, waba_phone_number_id) and supplied via env:
//   SUPPLY_WHATSAPP_ACCESS_TOKEN     — Meta Cloud API access token
//   SUPPLY_WHATSAPP_API_URL          — default https://graph.facebook.com/v18.0
//
// All functions are fire-safe: internal try/catch so a failed WA send
// never crashes the caller's request lifecycle.
//
// Exports:
//   sendSupplyWhatsAppMessage(toPhone, message, supplierId)  → bool
//   sendSupplyWhatsAppInteractive(toPhone, interactive, supplierId) → bool
// ============================================================================

'use strict';

const { resolveSupplyWabaCredentials } = require('../../helpers/supplyWabaCredentials');

const DEFAULT_API_URL = 'https://graph.facebook.com/v18.0';

// ── Credential resolution ────────────────────────────────────────────────────

async function _resolveSupplyCredentials(supplierId) {
  const creds = await resolveSupplyWabaCredentials(supplierId);
  if (!creds) return null;
  return {
    accessToken: creds.accessToken,
    phoneNumberId: creds.phoneNumberId,
    apiUrl: creds.apiUrl || DEFAULT_API_URL,
  };
}

// ── sendSupplyWhatsAppMessage ────────────────────────────────────────────────
// Sends a plain-text WhatsApp message via the supplier's WABA.
//
// @param {string}      toPhone     recipient phone (e.g. '919876543210')
// @param {string}      message     plain text body
// @param {string|null} supplierId  UUID — used to resolve per-supplier phone_number_id
// @returns {Promise<boolean>}

async function sendSupplyWhatsAppMessage(toPhone, message, supplierId = null) {
  try {
    const creds = await _resolveSupplyCredentials(supplierId);
    if (!creds) {
      console.warn('[supplyWhatsapp] Missing credentials — skipping message to', toPhone);
      return false;
    }

    const { accessToken, phoneNumberId, apiUrl } = creds;

    const response = await fetch(`${apiUrl}/${phoneNumberId}/messages`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:   String(toPhone),
        type: 'text',
        text: { body: message },
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[supplyWhatsapp] API error:', JSON.stringify(err).slice(0, 300));
      return false;
    }

    console.log(`[supplyWhatsapp] ✅ Sent to ${toPhone}`);
    return true;
  } catch (err) {
    console.error('[supplyWhatsapp] Failed to send message:', err.message);
    return false;
  }
}

// ── sendSupplyWhatsAppInteractive ─────────────────────────────────────────────
// Sends an interactive WhatsApp message (buttons, list) via the supplier's WABA.
//
// @param {string}      toPhone
// @param {object}      interactive  Meta interactive payload
// @param {string|null} supplierId
// @returns {Promise<boolean>}

async function sendSupplyWhatsAppInteractive(toPhone, interactive, supplierId = null) {
  try {
    const creds = await _resolveSupplyCredentials(supplierId);
    if (!creds) {
      console.warn('[supplyWhatsapp] Missing credentials — skipping interactive to', toPhone);
      return false;
    }

    const { accessToken, phoneNumberId, apiUrl } = creds;

    const response = await fetch(`${apiUrl}/${phoneNumberId}/messages`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:                String(toPhone),
        type:              'interactive',
        interactive,
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[supplyWhatsapp] Interactive API error:', JSON.stringify(err).slice(0, 300));
      return false;
    }

    console.log(`[supplyWhatsapp] ✅ Interactive sent to ${toPhone}`);
    return true;
  } catch (err) {
    console.error('[supplyWhatsapp] Interactive send failed:', err.message);
    return false;
  }
}

module.exports = {
  sendSupplyWhatsAppMessage,
  sendSupplyWhatsAppInteractive,
};
