// src/catalog.js
// Shared catalog/slot helpers imported by pos.js.
// Full implementations live in server.js — these delegate or re-export.

const { supabaseAdmin } = require('./config/supabase');

const SLOTS = [
  { startHour: 6,  endHour: 11, dbValue: 'morning_tiffin' },
  { startHour: 11, endHour: 15, dbValue: 'lunch'          },
  { startHour: 15, endHour: 19, dbValue: 'evening_snacks' },
  { startHour: 19, endHour: 23, dbValue: 'dinner_tiffin'  },
];

function getCurrentSlotIST() {
  const now        = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMinutes = (utcMinutes + 330) % (24 * 60);
  const istHour    = Math.floor(istMinutes / 60);
  const slot       = SLOTS.find(s => istHour >= s.startHour && istHour < s.endHour);
  return slot ? slot.dbValue : null;
}

async function applySlotAvailability(restaurantId, slotDbValue) {
  if (!slotDbValue) {
    await supabaseAdmin.from('menu_items')
      .update({ is_available: false, updated_at: new Date().toISOString() })
      .eq('restaurant_id', restaurantId);
    return { available: 0, unavailable: 'all' };
  }
  const { data: activated } = await supabaseAdmin.from('menu_items')
    .update({ is_available: true, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId).eq('is_stocked', true)
    .in('time_slot', [slotDbValue, 'all']).select('id');
  const { data: deactivated } = await supabaseAdmin.from('menu_items')
    .update({ is_available: false, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId)
    .not('time_slot', 'in', `("${slotDbValue}","all")`).select('id');
  await supabaseAdmin.from('menu_items')
    .update({ is_available: false, updated_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId).eq('is_stocked', false)
    .in('time_slot', [slotDbValue, 'all']);
  return { slot: slotDbValue, available: activated?.length ?? 0, unavailable: deactivated?.length ?? 0 };
}

async function triggerMetaFeedRefetch() {
  try {
    const META_ACCESS_TOKEN   = process.env.META_ACCESS_TOKEN;
    const META_DATA_SOURCE_ID = process.env.META_DATA_SOURCE_ID || process.env.META_FEED_ID || '936316552566754';
    if (!META_ACCESS_TOKEN) return;
    const feedsResp = await fetch(`https://graph.facebook.com/v20.0/${META_DATA_SOURCE_ID}/feeds?access_token=${META_ACCESS_TOKEN}`);
    const feedsData = await feedsResp.json();
    if (!feedsResp.ok || !feedsData.data?.length) {
      await fetch(`https://graph.facebook.com/v20.0/${META_DATA_SOURCE_ID}/uploads`, {
        method: 'POST', headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` },
      });
      return;
    }
    const feedId = feedsData.data[0].id;
    await fetch(`https://graph.facebook.com/v20.0/${feedId}/uploads`, {
      method: 'POST', headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` },
    });
  } catch (err) {
    console.warn('[meta-feed-trigger] Non-fatal:', err.message);
  }
}

function mapTimeSlot(raw) {
  if (!raw) return 'all';
  const SLOT_MAP = {
    'morning tiffin': 'morning_tiffin', 'morning_tiffin': 'morning_tiffin',
    'lunch': 'lunch',
    'evening snacks': 'evening_snacks', 'evening_snacks': 'evening_snacks',
    'dinner tiffin': 'dinner_tiffin',   'dinner_tiffin': 'dinner_tiffin',
    'dinner': 'dinner_tiffin', 'all': 'all',
  };
  return SLOT_MAP[String(raw).toLowerCase().trim()] || 'all';
}

module.exports = { getCurrentSlotIST, applySlotAvailability, triggerMetaFeedRefetch, mapTimeSlot };
