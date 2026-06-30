'use strict';

const { supabaseAdmin } = require('../config/supabase');

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function findNearestOutlet(restaurantId, lat, lng) {
  const { data: outlets, error } = await supabaseAdmin
    .from('outlets')
    .select('id, restaurant_id, name, lat, lng, delivery_radius_km, is_active')
    .eq('restaurant_id', restaurantId)
    .eq('is_active', true);

  if (error) {
    console.error('[outletMatching] failed to fetch outlets:', error.message);
    return null;
  }
  if (!Array.isArray(outlets) || outlets.length === 0) return null;

  let best = null;

  for (const outlet of outlets) {
    if (typeof outlet.lat !== 'number' || typeof outlet.lng !== 'number') continue;
    const radius = Number(outlet.delivery_radius_km || 0);
    if (radius <= 0) continue;

    const distanceKm = haversineKm(lat, lng, outlet.lat, outlet.lng);
    if (distanceKm <= radius) {
      if (!best || distanceKm < best.distanceKm) {
        best = { outlet, distanceKm };
      }
    }
  }

  return best;
}

module.exports = {
  findNearestOutlet,
  haversineKm,
};
