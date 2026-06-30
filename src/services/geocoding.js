'use strict';

const REVERSE_PREF_TYPES = new Set(['street_address', 'premise', 'subpremise', 'route']);

async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 180)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function dedupeCandidates(results, limit = 3) {
  const seen = new Set();
  const out = [];

  for (const r of results) {
    const formatted = r?.formatted_address;
    const lat = r?.geometry?.location?.lat;
    const lng = r?.geometry?.location?.lng;
    if (!formatted || typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (seen.has(formatted)) continue;

    seen.add(formatted);
    out.push({
      formatted_address: formatted,
      place_id: r.place_id || null,
      lat,
      lng,
    });

    if (out.length >= limit) break;
  }

  return out;
}

async function reverseGeocode(lat, lng) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.warn('[geocoding] GOOGLE_MAPS_API_KEY missing; reverse geocode disabled');
    return [];
  }

  try {
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(`${lat},${lng}`)}&key=${encodeURIComponent(key)}`;

    const data = await fetchJsonWithTimeout(url);

    if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) {
      console.warn('[geocoding] reverse geocode failed:', data.status || 'UNKNOWN');
      return [];
    }

    const preferred = data.results.filter((r) =>
      Array.isArray(r.types) && r.types.some((t) => REVERSE_PREF_TYPES.has(t))
    );

    const ranked = preferred.length > 0
      ? [...preferred, ...data.results]
      : data.results;

    return dedupeCandidates(ranked, 3);
  } catch (err) {
    console.error('[geocoding] reverse geocode error:', err.message);
    return [];
  }
}

async function forwardGeocode(addressText) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.warn('[geocoding] GOOGLE_MAPS_API_KEY missing; forward geocode disabled');
    return null;
  }

  try {
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addressText)}&key=${encodeURIComponent(key)}`;

    const data = await fetchJsonWithTimeout(url);
    if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) {
      console.warn('[geocoding] forward geocode failed:', data.status || 'UNKNOWN');
      return null;
    }

    const first = data.results[0];
    const lat = first?.geometry?.location?.lat;
    const lng = first?.geometry?.location?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;

    return {
      formatted_address: first.formatted_address || addressText,
      place_id: first.place_id || null,
      lat,
      lng,
    };
  } catch (err) {
    console.error('[geocoding] forward geocode error:', err.message);
    return null;
  }
}

module.exports = {
  reverseGeocode,
  forwardGeocode,
};
