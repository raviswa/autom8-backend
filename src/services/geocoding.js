'use strict';

const REVERSE_PREF_TYPES = new Set([
  'street_address', 'premise', 'subpremise', 'route',
  'establishment', 'point_of_interest', 'neighborhood',
  'sublocality', 'sublocality_level_1', 'sublocality_level_2',
  'locality', 'landmark',
]);

const PLACES_NEARBY_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const NOMINATIM_UA = 'MunafeDeliveryBot/1.0 (delivery-address-lookup)';

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 180)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function shortLabelFromAddress(formatted) {
  const clean = String(formatted || '').trim();
  return clean.includes(',') ? clean.split(',')[0].trim() : clean;
}

function simplifyPlaceName(name) {
  const clean = String(name || '').trim();
  const match = clean.match(/^zone\s+\d+\s+(.+)$/i);
  return match ? match[1].trim() : clean;
}

function isCoordinateOnlyLabel(text) {
  const clean = String(text || '').trim();
  if (!clean) return true;
  if (/^shared pin\b/i.test(clean)) return true;
  return /^[-]?\d{1,3}\.\d{3,}\s*,\s*[-]?\d{1,3}\.\d{3,}$/.test(clean);
}

function candidate(formattedAddress, lat, lng, shortLabel = null, placeId = null) {
  const formatted = String(formattedAddress || '').trim();
  const label = String(shortLabel || shortLabelFromAddress(formatted) || formatted).trim();
  return {
    formatted_address: formatted,
    short_label: label,
    place_id: placeId,
    lat,
    lng,
  };
}

function normalizeCandidateKey(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function mergeCandidates(candidates, limit = 4) {
  const seen = new Set();
  const out = [];

  for (const item of candidates) {
    const formatted = String(item?.formatted_address || '').trim();
    if (!formatted || isCoordinateOnlyLabel(formatted)) continue;

    const key = normalizeCandidateKey(formatted);
    const shortKey = normalizeCandidateKey(item?.short_label || '');
    if (seen.has(key) || (shortKey && seen.has(shortKey))) continue;

    seen.add(key);
    if (shortKey) seen.add(shortKey);
    out.push(item);
    if (out.length >= limit) break;
  }

  return out;
}

function dedupeGeocodeResults(results, limit = 4) {
  const raw = [];

  for (const r of results) {
    const formatted = r?.formatted_address;
    const lat = r?.geometry?.location?.lat;
    const lng = r?.geometry?.location?.lng;
    if (!formatted || typeof lat !== 'number' || typeof lng !== 'number') continue;

    let short = null;
    for (const comp of r.address_components || []) {
      const types = comp?.types || [];
      if (types.includes('route') || types.includes('neighborhood') || types.includes('sublocality')) {
        short = String(comp.long_name || comp.short_name || '').trim();
        if (short) break;
      }
    }

    raw.push(candidate(formatted, lat, lng, short, r.place_id || null));
  }

  return mergeCandidates(raw, limit);
}

function nominatimAddressVariants(data, lat, lng) {
  const addr = data?.address || {};
  const road = String(addr.road || addr.pedestrian || addr.residential || '').trim();
  const neighbourhood = simplifyPlaceName(String(addr.neighbourhood || addr.quarter || addr.hamlet || '').trim());
  const suburb = simplifyPlaceName(String(addr.suburb || addr.city_district || '').trim());
  const city = simplifyPlaceName(String(addr.city || addr.town || addr.village || addr.county || '').trim());
  const postcode = String(addr.postcode || '').trim();
  const state = String(addr.state || '').trim();

  const variants = [];
  if (road && suburb && city) variants.push([road, `${road}, ${suburb}, ${city}`]);
  else if (road && city) variants.push([road, `${road}, ${city}`]);
  else if (data?.name && road) variants.push([String(data.name), `${data.name}, ${road}, ${city || suburb}`.replace(/,\s*$/, '')]);

  if (neighbourhood && city && neighbourhood !== road && neighbourhood !== suburb) {
    variants.push([neighbourhood, `${neighbourhood}, ${city}`]);
  }
  if (suburb && city && suburb !== road && suburb !== neighbourhood) {
    variants.push([suburb, `${suburb}, ${city}`]);
  }
  if (city && postcode) variants.push([city, `${city}, ${postcode}`]);
  else if (city && state) variants.push([city, `${city}, ${state}`]);

  const display = String(data?.display_name || '').trim();
  if (display) variants.push([shortLabelFromAddress(display), display]);

  return variants
    .filter(([, formatted]) => formatted && !isCoordinateOnlyLabel(formatted))
    .map(([short, formatted]) => candidate(formatted, lat, lng, short));
}

async function googleNearbyPlaces(lat, lng, limit = 4) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return [];

  try {
    const url =
      `${PLACES_NEARBY_URL}?location=${encodeURIComponent(`${lat},${lng}`)}` +
      `&rankby=distance&key=${encodeURIComponent(key)}`;
    const data = await fetchJsonWithTimeout(url);
    if (!['OK', 'ZERO_RESULTS'].includes(data.status || '')) {
      console.warn('[geocoding] nearby places failed:', data.status || 'UNKNOWN');
      return [];
    }

    const raw = (data.results || [])
      .map((place) => {
        const name = String(place?.name || '').trim();
        const vicinity = String(place?.vicinity || '').trim();
        if (!name) return null;
        const formatted = vicinity ? `${name}, ${vicinity}` : name;
        const pLat = place?.geometry?.location?.lat;
        const pLng = place?.geometry?.location?.lng;
        return candidate(
          formatted,
          typeof pLat === 'number' ? pLat : lat,
          typeof pLng === 'number' ? pLng : lng,
          name,
          place.place_id || null,
        );
      })
      .filter(Boolean);

    return mergeCandidates(raw, limit);
  } catch (err) {
    console.error('[geocoding] nearby places error:', err.message);
    return [];
  }
}

async function googleReverseGeocode(lat, lng, limit = 4) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return [];

  try {
    const url =
      `${GEOCODE_URL}?latlng=${encodeURIComponent(`${lat},${lng}`)}&key=${encodeURIComponent(key)}`;
    const data = await fetchJsonWithTimeout(url);
    if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) {
      console.warn('[geocoding] reverse geocode failed:', data.status || 'UNKNOWN');
      return [];
    }

    const preferred = data.results.filter((r) =>
      Array.isArray(r.types) && r.types.some((t) => REVERSE_PREF_TYPES.has(t))
    );
    const ranked = preferred.length > 0 ? [...preferred, ...data.results] : data.results;
    return dedupeGeocodeResults(ranked, limit);
  } catch (err) {
    console.error('[geocoding] reverse geocode error:', err.message);
    return [];
  }
}

async function nominatimCandidates(lat, lng, limit = 4) {
  const raw = [];
  try {
    for (const zoom of [18, 16, 15]) {
      const url =
        `${NOMINATIM_REVERSE_URL}?lat=${encodeURIComponent(lat)}` +
        `&lon=${encodeURIComponent(lng)}&format=json&zoom=${zoom}&addressdetails=1`;
      const data = await fetchJsonWithTimeout(url, {
        headers: { 'User-Agent': NOMINATIM_UA },
      });
      const pLat = Number(data?.lat);
      const pLng = Number(data?.lon);
      raw.push(
        ...nominatimAddressVariants(
          data,
          Number.isFinite(pLat) ? pLat : lat,
          Number.isFinite(pLng) ? pLng : lng,
        ),
      );
      if (mergeCandidates(raw, limit).length >= limit) break;
    }
  } catch (err) {
    console.error('[geocoding] nominatim error:', err.message);
  }
  return mergeCandidates(raw, limit);
}

async function overpassNearbyPlaces(lat, lng, limit = 4) {
  const query = `[out:json][timeout:10];
(
  node["name"](around:350,${lat},${lng});
  way["name"](around:350,${lat},${lng});
);
out center ${Math.max(limit, 4)};`;

  try {
    const data = await fetchJsonWithTimeout(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'User-Agent': NOMINATIM_UA,
        'Content-Type': 'text/plain',
      },
      body: query,
    }, 12000);

    const raw = (data.elements || [])
      .map((el) => {
        const tags = el?.tags || {};
        const name = String(tags.name || '').trim();
        if (!name) return null;
        const street = String(tags['addr:street'] || tags['addr:full'] || '').trim();
        const suburb = simplifyPlaceName(String(tags['addr:suburb'] || tags['addr:city'] || '').trim());
        const formatted = street ? `${name}, ${street}` : (suburb ? `${name}, ${suburb}` : name);
        const center = el.center || el;
        const pLat = Number(center.lat);
        const pLng = Number(center.lon);
        return candidate(
          formatted,
          Number.isFinite(pLat) ? pLat : lat,
          Number.isFinite(pLng) ? pLng : lng,
          name,
        );
      })
      .filter(Boolean);

    return mergeCandidates(raw, limit);
  } catch (err) {
    console.error('[geocoding] overpass error:', err.message);
    return [];
  }
}

async function reverseGeocode(lat, lng, limit = 4) {
  let merged = [];

  for (const fetcher of [
    () => googleNearbyPlaces(lat, lng, limit),
    () => googleReverseGeocode(lat, lng, limit),
    () => overpassNearbyPlaces(lat, lng, limit),
    () => nominatimCandidates(lat, lng, limit),
  ]) {
    const batch = await fetcher();
    if (batch.length > 0) {
      merged = mergeCandidates([...merged, ...batch], limit);
    }
    if (merged.length >= limit) break;
  }

  return merged.slice(0, limit);
}

async function forwardGeocode(addressText) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.warn('[geocoding] GOOGLE_MAPS_API_KEY missing; forward geocode disabled');
    return null;
  }

  try {
    const url =
      `${GEOCODE_URL}?address=${encodeURIComponent(addressText)}&key=${encodeURIComponent(key)}`;

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
      short_label: shortLabelFromAddress(first.formatted_address || addressText),
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
  mergeCandidates,
  shortLabelFromAddress,
};
