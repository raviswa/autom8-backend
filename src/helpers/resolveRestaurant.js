// src/helpers/resolveRestaurant.js
// ============================================================================
// Resolves restaurant_id from a WhatsApp phone_number_id.
//
// Used by both webhook.js and waHandlers.js.
// Queries restaurant_integrations (not restaurants.whatsapp_phone_number_id
// which does not exist in the schema).
//
// In-memory cache (5-minute TTL) prevents a DB round-trip on every message.
// Cache is invalidated automatically by TTL — no explicit invalidation needed
// since phone_number_id → restaurant_id mappings rarely change.
// ============================================================================

'use strict';

const { supabaseAdmin } = require('../config/supabase');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _cache = new Map(); // phone_number_id → { restaurant_id, expires_at }

/**
 * Resolve restaurant_id from a WhatsApp phone_number_id.
 * Returns the restaurant UUID string, or null if not found.
 *
 * @param {string} phoneNumberId  — metadata.phone_number_id from the WA webhook
 * @returns {Promise<string|null>}
 */
async function resolveRestaurantByPhone(phoneNumberId) {
  if (!phoneNumberId) return null;

  // Check cache
  const cached = _cache.get(phoneNumberId);
  if (cached && Date.now() < cached.expires_at) {
    return cached.restaurant_id;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('tenant_integrations')
      .select('restaurant_id')
      .eq('phone_number_id', String(phoneNumberId).trim())
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      console.warn(`[resolveRestaurant] DB error for phone_number_id=${phoneNumberId}:`, error.message);
      return null;
    }

    const restaurantId = data?.restaurant_id ?? null;

    // Cache the result (even null — avoids hammering DB for invalid IDs)
    _cache.set(phoneNumberId, {
      restaurant_id: restaurantId,
      expires_at:    Date.now() + CACHE_TTL_MS,
    });

    return restaurantId;
  } catch (err) {
    console.warn(`[resolveRestaurant] Unexpected error:`, err.message);
    return null;
  }
}

/**
 * Manually invalidate a cached entry (call when a restaurant's
 * phone_number_id changes — e.g. from the brand WABA settings UI).
 */
function invalidatePhoneCache(phoneNumberId) {
  _cache.delete(phoneNumberId);
}

module.exports = { resolveRestaurantByPhone, invalidatePhoneCache };
