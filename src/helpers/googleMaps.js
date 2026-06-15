'use strict';

/**
 * Parse coordinates from common Google Maps URL formats.
 * Returns { lat, lng } or null.
 */
function parseGoogleMapsCoords(input) {
  if (!input || typeof input !== 'string') return null;
  const text = input.trim();

  let m = text.match(/[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  m = text.match(/[?&](?:ll|center)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  m = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  m = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  m = text.match(/place\/[^/]+\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  return null;
}

function isMapsUrl(text) {
  return typeof text === 'string' && /google\.com\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(text);
}

/** Pull a human place name from a Maps search/share URL (when q= is not lat,lng). */
function extractMapsPlaceQuery(input) {
  if (!input || typeof input !== 'string') return null;
  const text = input.trim();

  try {
    const url = new URL(text.startsWith('http') ? text : `https://${text}`);
    const q = url.searchParams.get('q');
    if (q && !/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(q)) {
      return decodeURIComponent(q.replace(/\+/g, ' ')).trim();
    }
  } catch (_) {}

  const placeMatch = text.match(/\/maps\/place\/([^/@?]+)/);
  if (placeMatch) {
    return decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).trim();
  }

  const qMatch = text.match(/[?&]q=([^&]+)/);
  if (qMatch) {
    const q = decodeURIComponent(qMatch[1].replace(/\+/g, ' ')).trim();
    if (q && !/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(q)) return q;
  }

  return null;
}

function mapsApiKey() {
  return (
    process.env.GOOGLE_MAPS_API_KEY
    || process.env.GOOGLE_API_KEY
    || ''
  ).trim();
}

async function geocodeAddress(address, { city = '', state = '', country = 'India' } = {}) {
  const key = mapsApiKey();
  if (!key || !address?.trim()) return null;

  let query = address.trim();
  if (isMapsUrl(query)) {
    const place = extractMapsPlaceQuery(query);
    if (!place) return null;
    query = place;
  }

  if (city && !query.toLowerCase().includes(city.toLowerCase())) query += `, ${city}`;
  if (state && !query.toLowerCase().includes(state.toLowerCase())) query += `, ${state}`;
  if (country && !query.toLowerCase().includes(country.toLowerCase())) query += `, ${country}`;

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', query);
  url.searchParams.set('key', key);
  url.searchParams.set('region', 'in');
  url.searchParams.set('components', 'country:IN');

  const res = await fetch(url.toString());
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== 'OK' || !data.results?.length) return null;

  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
}

function resolveFailureMessage({ mapsUrl, address } = {}) {
  const hasKey = !!mapsApiKey();
  const hasCoords = [mapsUrl, address].some(v => v && parseGoogleMapsCoords(v));
  if (!hasCoords && !hasKey) {
    return 'Could not resolve coordinates. Paste a Google Maps pin link (Share → copy link), or set GOOGLE_MAPS_API_KEY on the server for address lookup.';
  }
  if (isMapsUrl(address) && !extractMapsPlaceQuery(address) && !parseGoogleMapsCoords(address)) {
    return 'That looks like a Maps search link. Open the place in Google Maps → Share → copy the full maps.google.com link, or enter a plain-text address.';
  }
  return 'Could not resolve coordinates from that link or address. Use a pin link with coordinates, or a plain-text pickup address.';
}

/**
 * Resolve pickup coordinates from a Maps share link and/or text address.
 */
async function resolvePickupLocation({ mapsUrl, address, city, state }) {
  for (const raw of [mapsUrl, address].filter(Boolean)) {
    const fromUrl = parseGoogleMapsCoords(raw);
    if (fromUrl) return { ...fromUrl, source: 'maps_url' };
  }

  const geocodeTargets = [];
  if (address?.trim() && !isMapsUrl(address)) geocodeTargets.push(address.trim());
  for (const raw of [mapsUrl, address].filter(Boolean)) {
    const place = extractMapsPlaceQuery(raw);
    if (place) geocodeTargets.push(place);
  }

  for (const target of [...new Set(geocodeTargets)]) {
    const fromAddress = await geocodeAddress(target, { city, state });
    if (fromAddress) return { ...fromAddress, source: 'geocode' };
  }

  return null;
}

module.exports = {
  parseGoogleMapsCoords,
  extractMapsPlaceQuery,
  isMapsUrl,
  geocodeAddress,
  resolvePickupLocation,
  resolveFailureMessage,
  mapsApiKey,
};
