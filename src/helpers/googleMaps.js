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

  m = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  m = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  m = text.match(/place\/[^/]+\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

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

/**
 * Resolve pickup coordinates from a Maps share link and/or text address.
 */
async function resolvePickupLocation({ mapsUrl, address, city, state }) {
  if (mapsUrl) {
    const fromUrl = parseGoogleMapsCoords(mapsUrl);
    if (fromUrl) return { ...fromUrl, source: 'maps_url' };
  }

  const fromAddress = await geocodeAddress(address, { city, state });
  if (fromAddress) return { ...fromAddress, source: 'geocode' };

  return null;
}

module.exports = {
  parseGoogleMapsCoords,
  geocodeAddress,
  resolvePickupLocation,
  mapsApiKey,
};
