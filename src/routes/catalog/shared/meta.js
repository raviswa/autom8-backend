'use strict';

const { supabaseAdmin } = require('../../../config/supabase');
const { getMetaCatalogId, getWhatsAppIntegration } = require('../../../helpers/restaurantConfig');
const { getCurrentSlotIST, applySlotAvailability } = require('./slots');

async function syncCatalogFromMeta(restaurantId) {
  const META_CATALOG_ID = await getMetaCatalogId(restaurantId);
  const creds = await getWhatsAppIntegration(restaurantId);
  const META_ACCESS_TOKEN = creds?.accessToken || process.env.META_ACCESS_TOKEN;
  if (!META_ACCESS_TOKEN || !META_CATALOG_ID) {
    return { success: false, error: 'Missing Meta catalog or access token for this restaurant' };
  }

  console.log(`🔄 [catalog-sync] Starting for restaurant ${restaurantId}...`);
  try {
    let allProducts = [], nextUrl =
      `https://graph.facebook.com/v20.0/${META_CATALOG_ID}/products` +
      `?fields=id,name,description,price,currency,image_url,availability,category,retailer_id,custom_label_0` +
      `&limit=100&access_token=${META_ACCESS_TOKEN}`;

    while (nextUrl) {
      const resp = await fetch(nextUrl);
      const data = await resp.json();
      if (data.error) throw new Error(`Meta API: ${data.error.message}`);
      allProducts = [...allProducts, ...(data.data || [])];
      nextUrl = data.paging?.next || null;
    }

    let synced = 0, skipped = 0;
    const errors = [];
    const SLOT_MAP = { 'morning tiffin': 'morning_tiffin', lunch: 'lunch', 'evening snacks': 'snacks', 'dinner tiffin': 'dinner' };

    for (const product of allProducts) {
      try {
        let price = 0;
        if (typeof product.price === 'string') {
          const numeric = parseFloat(product.price.replace(/[^0-9.]/g, ''));
          if (!isNaN(numeric)) {
            price = (product.price.includes('₹') || product.price.toUpperCase().includes('INR'))
              ? numeric : numeric / 100;
          }
        } else if (typeof product.price === 'number') {
          price = product.price > 100 ? product.price / 100 : product.price;
        }

        const timeSlot = SLOT_MAP[(product.custom_label_0 || '').trim().toLowerCase()] || 'all';
        const { error } = await supabaseAdmin.from('menu_items').upsert({
          restaurant_id: restaurantId, name: product.name?.trim(),
          description:   product.description?.trim() || '',
          price, image_url: product.image_url || null,
          category:      product.category || 'General',
          time_slot:     timeSlot,
          meta_product_id: product.id,
          retailer_id:   product.retailer_id || product.id,
          updated_at:    new Date().toISOString(),
        }, { onConflict: 'restaurant_id,meta_product_id', ignoreDuplicates: false });

        if (error) throw error;
        synced++;
      } catch (itemErr) {
        skipped++;
        errors.push({ product_id: product.id, error: itemErr.message });
      }
    }

    await applySlotAvailability(restaurantId, getCurrentSlotIST());
    return { success: true, synced, skipped, total: allProducts.length };
  } catch (err) {
    console.error('❌ Catalog sync failed:', err.message);
    return { success: false, error: err.message };
  }
}

async function triggerMetaFeedRefetch() {
  try {
    const token    = process.env.META_ACCESS_TOKEN;
    const sourceId = process.env.META_DATA_SOURCE_ID || process.env.META_FEED_ID;
    if (!token || !sourceId) return;

    const feedsResp = await fetch(
      `https://graph.facebook.com/v20.0/${sourceId}/feeds?access_token=${token}`
    );
    const feedsData = await feedsResp.json();

    if (!feedsResp.ok || !feedsData.data?.length) {
      const r = await fetch(`https://graph.facebook.com/v20.0/${sourceId}/uploads`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) console.log(`[meta-feed-trigger] ✅ Direct trigger`);
      return;
    }

    const feedId = feedsData.data[0].id;
    const resp   = await fetch(`https://graph.facebook.com/v20.0/${feedId}/uploads`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (resp.ok) console.log(`[meta-feed-trigger] ✅ Feed upload triggered`);
  } catch (err) {
    console.warn('[meta-feed-trigger] Non-fatal:', err.message);
  }
}

async function pushSingleItemToMetaCatalog({ retailerId, isAvailable, restaurantId }) {
  const META_CATALOG_ID = await getMetaCatalogId(restaurantId);
  const creds = await getWhatsAppIntegration(restaurantId);
  const META_ACCESS_TOKEN = creds?.accessToken || process.env.META_ACCESS_TOKEN;
  if (!META_ACCESS_TOKEN || !META_CATALOG_ID) return;

  const { data: item } = await supabaseAdmin
    .from('menu_items').select('name, description, price, image_url, time_slot')
    .eq('retailer_id', retailerId).eq('restaurant_id', restaurantId).maybeSingle();

  const SLOT_LABEL = {
    morning_tiffin: 'Morning Tiffin', lunch: 'Lunch',
    snacks: 'Evening Snacks', dinner: 'Dinner', all: 'All Day',
  };

  const batchPayload = {
    allow_upsert: true,
    requests: [{
      method:      'UPDATE',
      retailer_id: retailerId,
      data: {
        availability: isAvailable ? 'in stock' : 'out of stock',
        ...(item ? {
          name:           item.name        || '',
          description:    item.description || '',
          price:          Math.round((parseFloat(item.price) || 0) * 100),
          currency:       'INR',
          image_url:      item.image_url   || '',
          custom_label_0: SLOT_LABEL[item.time_slot] || 'All Day',
          url:            process.env.FRONTEND_URL || 'https://autom8.works/',
          brand:          'Munafe',
          category:       'FOOD_AND_DRINK',
        } : {}),
      },
    }],
  };

  const resp   = await fetch(`https://graph.facebook.com/v20.0/${META_CATALOG_ID}/batch`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(batchPayload),
    signal:  AbortSignal.timeout(8_000),
  });
  const result = await resp.json();
  if (!resp.ok || result.error) throw new Error(JSON.stringify(result.error || result));
  console.log(`[meta-single-push] ✅ ${retailerId} → ${isAvailable ? 'in stock' : 'out of stock'}`);
}

module.exports = {
  syncCatalogFromMeta,
  triggerMetaFeedRefetch,
  pushSingleItemToMetaCatalog,
};
