'use strict';

require('dotenv').config();

const { supabaseAdmin } = require('../src/config/supabase');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function usage() {
  console.log('Usage: node scripts/seedOutlets.js --restaurant <restaurantId> [--lat <lat>] [--lng <lng>] [--radius <km>] [--prefix <namePrefix>]');
}

async function main() {
  const args = parseArgs(process.argv);
  const restaurantId = args.restaurant;
  if (!restaurantId) {
    usage();
    process.exit(1);
  }

  const baseLat = toNum(args.lat, 13.0660);
  const baseLng = toNum(args.lng, 80.2420);
  const baseRadius = toNum(args.radius, 5);
  const prefix = String(args.prefix || 'Test Outlet').trim();

  // Two close outlets with overlapping radii to validate nearest-outlet logic.
  const rows = [
    {
      restaurant_id: restaurantId,
      name: `${prefix} A`,
      address: 'Seeded overlap outlet A',
      lat: baseLat,
      lng: baseLng,
      delivery_radius_km: baseRadius,
      is_active: true,
    },
    {
      restaurant_id: restaurantId,
      name: `${prefix} B`,
      address: 'Seeded overlap outlet B',
      lat: baseLat + 0.0085,
      lng: baseLng + 0.0060,
      delivery_radius_km: baseRadius,
      is_active: true,
    },
  ];

  const { data, error } = await supabaseAdmin
    .from('outlets')
    .insert(rows)
    .select('id, name, lat, lng, delivery_radius_km, is_active');

  if (error) {
    console.error('[seedOutlets] insert failed:', error.message);
    process.exit(1);
  }

  console.log('[seedOutlets] inserted outlets:');
  for (const row of data || []) {
    console.log(`- ${row.name} | id=${row.id} | lat=${row.lat} lng=${row.lng} radius=${row.delivery_radius_km}km`);
  }
}

main().catch((err) => {
  console.error('[seedOutlets] fatal:', err.message);
  process.exit(1);
});
