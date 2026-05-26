// src/config/regionConfig.js
// One file per region. Each Railway service sets REGION=IN|AE|EU.
// All other env vars (SUPABASE_URL, keys, WhatsApp creds) are set
// per-service in Railway — no values are hardcoded here.

const configs = {
  IN: {
    region:      'IN',
    currency:    'INR',
    timezone:    'Asia/Kolkata',
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey:     process.env.SUPABASE_ANON_KEY,
  },
  AE: {
    region:      'AE',
    currency:    'AED',
    timezone:    'Asia/Dubai',
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey:     process.env.SUPABASE_ANON_KEY,
  },
  EU: {
    region:      'EU',
    currency:    'EUR',
    timezone:    'Europe/Berlin',
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey:     process.env.SUPABASE_ANON_KEY,
  },
};

const region = process.env.REGION || 'IN';

if (!configs[region]) {
  throw new Error(
    `Unknown REGION="${region}". Must be one of: ${Object.keys(configs).join(', ')}. ` +
    `Set the REGION env var in Railway.`
  );
}

module.exports = configs[region];
