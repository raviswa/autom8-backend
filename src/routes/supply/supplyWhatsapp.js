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

const { supabaseAdmin } = require('../../config/supabase');

const DEFAULT_API_URL = 'https://graph.facebook.com/v18.0';

// ── Credential resolution ────────────────────────────────────────────────────
// Priority:
//   1. suppliers.waba_phone_number_id + SUPPLY_WHATSAPP_ACCESS_TOKEN (per-supplier)
//   2. SUPPLY_WHATSAPP_PHONE_NUMBER_ID + SUPPLY_WHATSAPP_ACCESS_TOKEN (global fallback)
//
// This mirrors the restaurant WhatsApp credential pattern in
// src/helpers/whatsapp.js / restaurantConfig.js.

async function _resolveSupplyCredentials(supplierId) {
  let phoneNumberId = process.env.SUPPLY_WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.SUPPLY_WHATSAPP_ACCESS_TOKEN;
  const apiUrl      = process.env.SUPPLY_WHATSAPP_API_URL || DEFAULT_API_URL;

  if (supplierId) {
    try {
      const { data: supplier } = await supabaseAdmin
        .from('suppliers')
        .select('waba_phone_number_id')
        .eq('id', supplierId)
        .maybeSingle();

      if (supplier?.waba_phone_number_id) {
        phoneNumberId = supplier.waba_phone_number_id;
      }
    } catch (err) {
      console.warn('[supplyWhatsapp] Supplier credential lookup failed:', err.message);
    }
  }

  if (!accessToken || !phoneNumberId) {
    return null;
  }

  return { accessToken, phoneNumberId, apiUrl };
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
