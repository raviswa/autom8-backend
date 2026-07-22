'use strict';

const { supabaseAdmin } = require('../../../config/supabase');

const SLOTS = [
  { startHour:  6, endHour: 11, dbValue: 'morning_tiffin' },
  { startHour: 11, endHour: 15, dbValue: 'lunch'          },
  { startHour: 15, endHour: 19, dbValue: 'snacks'         },
  { startHour: 19, endHour: 24, dbValue: 'dinner'         },
];

function getCurrentSlotIST() {
  const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const hour   = nowIST.getUTCHours();
  return SLOTS.find(s => hour >= s.startHour && hour < s.endHour)?.dbValue ?? null;
}

const SLOT_DISPLAY_LABELS = {
  morning_tiffin: 'Morning Tiffin',
  lunch:          'Lunch',
  snacks:         'Evening Snacks',
  dinner:         'Dinner',
};

// Manual manager-open overrides outside slot hours.
// This is intentionally in-memory: it controls scheduler behavior at runtime
// so a manual open is not immediately overwritten by slot rotation.
const MANUAL_KITCHEN_OPEN_OVERRIDES = new Set();

function nextOpenLabelIST() {
  const hour = new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCHours();
  for (const s of SLOTS) {
    if (hour < s.startHour) {
      const h12 = s.startHour % 12 || 12;
      const ampm = s.startHour < 12 ? 'AM' : 'PM';
      return `${h12}:00 ${ampm}`;
    }
  }
  const first = SLOTS[0];
  const h12 = first.startHour % 12 || 12;
  return `${h12}:00 AM`;
}

function nextOpenSlotDescriptionIST() {
  const hour = new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCHours();
  for (const s of SLOTS) {
    if (hour < s.startHour) {
      const label = SLOT_DISPLAY_LABELS[s.dbValue];
      const h12 = s.startHour % 12 || 12;
      const ampm = s.startHour < 12 ? 'AM' : 'PM';
      return `${label} at ${h12}:00 ${ampm}`;
    }
  }
  const first = SLOTS[0];
  const h12 = first.startHour % 12 || 12;
  return `${SLOT_DISPLAY_LABELS[first.dbValue]} at ${h12}:00 AM`;
}

function currentSlotLabelIST() {
  const slot = getCurrentSlotIST();
  return slot ? SLOT_DISPLAY_LABELS[slot] : null;
}

function mapTimeSlot(raw) {
  if (!raw) return 'all';
  const MAP = {
    'morning tiffin': 'morning_tiffin', morning_tiffin: 'morning_tiffin',
    lunch: 'lunch',
    'evening snacks': 'snacks',         snacks: 'snacks', evening_snacks: 'snacks',
    'dinner tiffin':  'dinner',         dinner: 'dinner', dinner_tiffin: 'dinner',
    all: 'all',
  };
  return MAP[String(raw).toLowerCase().trim()] || 'all';
}

/** DB time_slot values that belong to the active scheduler slot (aliases included). */
function slotDbValuesForActive(slotDbValue) {
  const ALIASES = {
    morning_tiffin: ['morning_tiffin'],
    lunch:          ['lunch'],
    snacks:         ['snacks', 'evening_snacks'],
    dinner:         ['dinner', 'dinner_tiffin'],
  };
  return ALIASES[slotDbValue] ?? [slotDbValue];
}

async function applySlotAvailability(restaurantId, slotDbValue) {
  console.log(`⏰ Applying slot: ${slotDbValue ?? 'CLOSED'} for restaurant ${restaurantId}`);
  if (!slotDbValue) {
    await supabaseAdmin.from('menu_items')
      .update({ is_available: false, updated_at: new Date().toISOString() })
      .eq('restaurant_id', restaurantId);
    return { available: 0, unavailable: 'all' };
  }
  const activeSlots = [...slotDbValuesForActive(slotDbValue), 'all'];
  const { data: activated,   error: e1 } = await supabaseAdmin.from('menu_items')
    .update({ is_available: true,  updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId).eq('is_stocked', true)
    .is('archived_at', null)
    .in('time_slot', activeSlots).select('id');
  if (e1) throw e1;
  const inList = activeSlots.map(s => `"${s}"`).join(',');
  const { data: deactivated, error: e2 } = await supabaseAdmin.from('menu_items')
    .update({ is_available: false, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId)
    .not('time_slot', 'in', `(${inList})`).select('id');
  if (e2) throw e2;
  await supabaseAdmin.from('menu_items')
    .update({ is_available: false, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId).eq('is_stocked', false)
    .is('archived_at', null)
    .in('time_slot', activeSlots);
  console.log(`  ✅ Activated: ${activated?.length ?? 0} | Deactivated: ${deactivated?.length ?? 0}`);
  return { slot: slotDbValue, available: activated?.length ?? 0, unavailable: deactivated?.length ?? 0 };
}

async function applySlotForAllRestaurants() {
  const slot = getCurrentSlotIST();
  const { data: restaurants } = await supabaseAdmin.from('tenants').select('id').eq('is_active', true);
  for (const r of restaurants ?? []) {
    if (!slot && MANUAL_KITCHEN_OPEN_OVERRIDES.has(r.id)) {
      console.log(`[slot] Keeping manual-open override for restaurant ${r.id} while slot is CLOSED`);
      continue;
    }
    await applySlotAvailability(r.id, slot).catch(e => console.error(`[slot] Failed for ${r.id}:`, e.message));
  }
}

module.exports = {
  SLOTS,
  getCurrentSlotIST,
  SLOT_DISPLAY_LABELS,
  MANUAL_KITCHEN_OPEN_OVERRIDES,
  nextOpenLabelIST,
  nextOpenSlotDescriptionIST,
  currentSlotLabelIST,
  mapTimeSlot,
  slotDbValuesForActive,
  applySlotAvailability,
  applySlotForAllRestaurants,
};
