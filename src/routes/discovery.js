'use strict';

/**
 * Internal restaurant discovery proxy — Google Places Text Search + Details.
 * Browser cannot call Google Places directly (CORS + key exposure).
 * Uses GOOGLE_MAPS_API_KEY / GOOGLE_API_KEY from server env.
 */

const express = require('express');
const router = express.Router();

const { requireKdsSecret } = require('../middleware/internalAuth');
const { mapsApiKey } = require('../helpers/googleMaps');

function googleKey() {
  const key = mapsApiKey();
  if (!key) return null;
  return key;
}

function googleErrorMessage(status, errorMessage) {
  const map = {
    REQUEST_DENIED: 'API key denied. Enable "Places API" in Google Cloud Console, enable billing, and ensure the key is not restricted to wrong APIs/referrers.',
    INVALID_REQUEST: 'Invalid search request.',
    OVER_QUERY_LIMIT: 'Google Places quota exceeded. Try again later or check billing.',
    ZERO_RESULTS: 'No places found for this query.',
    UNKNOWN_ERROR: 'Google Places returned an unknown error. Retry.',
  };
  return errorMessage || map[status] || `Google Places error: ${status}`;
}

async function placesTextSearch(query, pageToken) {
  const key = googleKey();
  if (!key) {
    return { ok: false, status: 503, error: 'GOOGLE_MAPS_API_KEY is not configured on the server.' };
  }

  const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
  url.searchParams.set('query', query);
  url.searchParams.set('key', key);
  if (pageToken) url.searchParams.set('pagetoken', pageToken);

  const res = await fetch(url.toString());
  const data = await res.json();

  if (data.status === 'OK' || data.status === 'ZERO_RESULTS') {
    return { ok: true, data };
  }

  return {
    ok: false,
    status: data.status === 'OVER_QUERY_LIMIT' ? 429 : 403,
    error: googleErrorMessage(data.status, data.error_message),
    googleStatus: data.status,
  };
}

async function placesDetails(placeId) {
  const key = googleKey();
  if (!key) {
    return { ok: false, status: 503, error: 'GOOGLE_MAPS_API_KEY is not configured on the server.' };
  }

  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'formatted_phone_number,international_phone_number,name,rating,user_ratings_total,opening_hours,types,formatted_address,geometry');
  url.searchParams.set('key', key);

  const res = await fetch(url.toString());
  const data = await res.json();

  if (data.status === 'OK') {
    return { ok: true, data: data.result };
  }

  return {
    ok: false,
    status: 403,
    error: googleErrorMessage(data.status, data.error_message),
    googleStatus: data.status,
  };
}

/** POST /api/discovery/search  { query, pageToken? } */
router.post('/search', requireKdsSecret, async (req, res) => {
  try {
    const query = String(req.body.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });

    const result = await placesTextSearch(query, req.body.pageToken || null);
    if (!result.ok) {
      return res.status(result.status || 403).json({
        error: result.error,
        googleStatus: result.googleStatus,
      });
    }

    return res.json({
      results: result.data.results || [],
      next_page_token: result.data.next_page_token || null,
      status: result.data.status,
    });
  } catch (err) {
    console.error('[discovery/search]', err);
    return res.status(500).json({ error: 'Search failed' });
  }
});

/** GET /api/discovery/details/:placeId */
router.get('/details/:placeId', requireKdsSecret, async (req, res) => {
  try {
    const placeId = String(req.params.placeId || '').trim();
    if (!placeId) return res.status(400).json({ error: 'placeId is required' });

    const result = await placesDetails(placeId);
    if (!result.ok) {
      return res.status(result.status || 403).json({
        error: result.error,
        googleStatus: result.googleStatus,
      });
    }

    return res.json({ result: result.data });
  } catch (err) {
    console.error('[discovery/details]', err);
    return res.status(500).json({ error: 'Details lookup failed' });
  }
});

/** GET /api/discovery/health — key configured? */
router.get('/health', requireKdsSecret, (_req, res) => {
  res.json({ ok: true, hasGoogleKey: !!googleKey() });
});

module.exports = router;
