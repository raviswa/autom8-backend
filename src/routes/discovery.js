// src/routes/discovery.js
const express = require('express');
const router  = express.Router();

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const KDS_SECRET     = process.env.AUTOM8_KDS_SECRET;
const PLACES_BASE    = 'https://maps.googleapis.com/maps/api/place';

// ── Auth middleware ───────────────────────────────────────────
function requireSecret(req, res, next) {
  if (!KDS_SECRET) return res.status(500).json({ error: 'AUTOM8_KDS_SECRET not configured on server' });
  if (req.headers['x-internal-secret'] !== KDS_SECRET) {
    return res.status(403).json({ error: 'Forbidden — wrong internal secret' });
  }
  next();
}

// ── POST /api/discovery/search ────────────────────────────────
router.post('/search', requireSecret, async (req, res) => {
  if (!GOOGLE_API_KEY) {
    return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not configured on server' });
  }

  const { query, pageToken } = req.body;

  const params = new URLSearchParams({ key: GOOGLE_API_KEY });
  if (pageToken) {
    params.set('pagetoken', pageToken);
  } else {
    if (!query) return res.status(400).json({ error: 'query is required' });
    params.set('query', query);
  }

  try {
    const response = await fetch(`${PLACES_BASE}/textsearch/json?${params}`);
    const data = await response.json();

    if (data.status === 'REQUEST_DENIED') {
      return res.status(502).json({
        error: data.error_message || 'Google Places request denied',
        googleStatus: 'REQUEST_DENIED',
      });
    }

    res.json(data);
  } catch (err) {
    console.error('[discovery/search]', err);
    res.status(502).json({ error: 'Failed to reach Google Places API' });
  }
});

// ── GET /api/discovery/details/:placeId ──────────────────────
router.get('/details/:placeId', requireSecret, async (req, res) => {
  if (!GOOGLE_API_KEY) {
    return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not configured on server' });
  }

  const { placeId } = req.params;
  const params = new URLSearchParams({
    place_id: placeId,
    fields:   'formatted_phone_number,international_phone_number',
    key:      GOOGLE_API_KEY,
  });

  try {
    const response = await fetch(`${PLACES_BASE}/details/json?${params}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[discovery/details]', err);
    res.status(502).json({ error: 'Failed to reach Google Places API' });
  }
});

module.exports = router;
