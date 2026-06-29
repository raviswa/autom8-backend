// src/helpers/resolveSupplier.js
// ============================================================================
// Resolves supplier_id from a WhatsApp phone_number_id.
//
// Mirror of resolveRestaurant.js — same cache pattern, different table.
// Used by src/routes/supply/webhook.js to identify which supplier owns
// an incoming WhatsApp message.
//
// suppliers.waba_phone_number_id stores the Meta phone_number_id string
// for each supplier's dedicated WhatsApp Business line.
//
// Cache TTL: 5 minutes (safe — suppliers rarely change their WABA number)
// ============================================================================

'use strict';

const { supabaseAdmin } = require('../config/supabase');

const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map(); // phone_number_id → { supplier_id, expires_at }

/**
 * Resolve supplier_id from a WhatsApp phone_number_id.
 * Returns the supplier UUID string, or null if not found.
 *
 * @param {string} phoneNumberId  — metadata.phone_number_id from the WA webhook
 * @returns {Promise<string|null>}
 */
async function resolveSupplierByPhone(phoneNumberId) {
  if (!phoneNumberId) return null;

  // Check in-process cache
  const cached = _cache.get(phoneNumberId);
  if (cached && Date.now() < cached.expires_at) {
    return cached.supplier_id;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('suppliers')
      .select('id')
      .eq('waba_phone_number_id', String(phoneNumberId).trim())
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      console.warn(`[resolveSupplier] DB error for phone_number_id=${phoneNumberId}:`, error.message);
      return null;
    }

    const supplierId = data?.id ?? null;

    // Cache result (even null — prevents hammering DB for unknown numbers)
    _cache.set(phoneNumberId, {
      supplier_id: supplierId,
      expires_at:  Date.now() + CACHE_TTL_MS,
    });

    return supplierId;
  } catch (err) {
    console.warn('[resolveSupplier] Unexpected error:', err.message);
    return null;
  }
}

/**
 * Resolve the client_id for an incoming WhatsApp message.
 * Matches sender phone against supply_clients.phone for a given supplier.
 *
 * Phone normalisation: Meta sends numbers without '+' (e.g. "919876543210").
 * supply_clients.phone may be stored with or without country code.
 * We match on suffix to handle both formats.
 *
 * @param {string} senderPhone  — raw phone from message.from (e.g. "919876543210")
 * @param {string} supplierId
 * @returns {Promise<{ id, name, phone, credit_limit, credit_auto_block } | null>}
 */
async function resolveClientByPhone(senderPhone, supplierId) {
  if (!senderPhone || !supplierId) return null;

  // Normalise: strip leading '+' or country code prefix (91 for IN)
  // Store both the raw and a 10-digit form for fuzzy matching
  const raw10 = senderPhone.replace(/^\+/, '').replace(/^91/, '').slice(-10);

  try {
    const { data: clients, error } = await supabaseAdmin
      .from('supply_clients')
      .select('id, name, phone, credit_limit, credit_auto_block, is_active')
      .eq('supplier_id', supplierId)
      .eq('is_active', true);

    if (error || !clients) return null;

    // Match against last 10 digits of stored phone
    return clients.find(c => {
      const stored10 = c.phone.replace(/^\+/, '').replace(/^91/, '').replace(/\D/g, '').slice(-10);
      return stored10 === raw10;
    }) ?? null;

  } catch (err) {
    console.warn('[resolveSupplier] resolveClientByPhone error:', err.message);
    return null;
  }
}

module.exports = { resolveSupplierByPhone, resolveClientByPhone };
