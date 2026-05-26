// src/config/supabase.js
// Single Supabase client init for the entire backend (POS + chat tables).
// Replaces the three separate client inits in server.js:
//   - supabase       → use supabase (anon key, for auth)
//   - supabaseAdmin  → use supabaseAdmin (service role)
//   - supabaseChat   → REMOVED — chat tables now live in the same DB

const { createClient } = require('@supabase/supabase-js');
const region = require('./regionConfig');

if (!region.supabaseUrl || !region.supabaseKey) {
  throw new Error(
    `Missing Supabase credentials for region ${region.region}. ` +
    `Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in Railway.`
  );
}

// Public client — used for auth (signIn, getUser). Uses anon key.
const supabase = createClient(region.supabaseUrl, region.anonKey);

// Admin client — used for all DB reads/writes. Uses service_role key.
const supabaseAdmin = createClient(region.supabaseUrl, region.supabaseKey);

console.log(`[supabase] ✅ Connected to ${region.supabaseUrl} (region: ${region.region})`);

module.exports = { supabase, supabaseAdmin };
