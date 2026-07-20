'use strict';

/**
 * Product affinity cache for webcart recommendations.
 * Reuses the same co-purchase math as OwnerInsights (buildAffinityIndex),
 * refreshed on a schedule and optionally personalized from the customer's
 * own order history (RFM-style favourites).
 */

const {
  fetchOrderRevenueById,
  buildAffinityIndex,
  extractItemName,
  normPhone,
} = require('./dashboardAnalytics');

const DEFAULT_LOOKBACK_DAYS = 90;
const STALE_MS = 24 * 60 * 60 * 1000;
const MIN_PAIR_COUNT = 2;

function phoneVariants(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return [];
  const last10 = digits.slice(-10);
  const out = new Set([digits, last10]);
  if (last10.length === 10) {
    out.add(`91${last10}`);
    out.add(`+91${last10}`);
  }
  return [...out].filter(Boolean);
}

function isCacheFresh(cache, maxAgeMs = STALE_MS) {
  if (!cache || typeof cache !== 'object') return false;
  if (!cache.by_item || typeof cache.by_item !== 'object') return false;
  const ts = Date.parse(cache.updated_at || '');
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) < maxAgeMs;
}

async function computeAffinityFromOrders(supabaseAdmin, restaurantId, { lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const { data: orders, error } = await supabaseAdmin
    .from('orders')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .gte('created_at', since)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(2500);

  if (error) throw error;
  const orderIds = (orders || []).map((o) => o.id).filter(Boolean);
  const { orderItems } = await fetchOrderRevenueById(supabaseAdmin, orderIds, {
    restaurantId,
    lookbackDays,
  });

  const index = buildAffinityIndex(orderItems, {
    minPairCount: MIN_PAIR_COUNT,
    topPartners: 10,
    topPairs: 24,
  });

  return {
    updated_at: new Date().toISOString(),
    lookback_days: lookbackDays,
    order_count: orderIds.length,
    basket_count: index.order_basket_count,
    pairs: index.pairs,
    by_item: index.by_item,
  };
}

async function refreshRestaurantAffinity(supabaseAdmin, restaurantId, opts = {}) {
  const payload = await computeAffinityFromOrders(supabaseAdmin, restaurantId, opts);
  const { error } = await supabaseAdmin
    .from('tenants')
    .update({ product_affinity: payload })
    .eq('id', restaurantId);
  if (error) throw error;
  return payload;
}

async function refreshAllAffinities(supabaseAdmin, { lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const { data: tenants, error } = await supabaseAdmin
    .from('tenants')
    .select('id, name, lob_type')
    .eq('is_active', true)
    .limit(500);
  if (error) throw error;

  let refreshed = 0;
  let failed = 0;
  for (const t of tenants || []) {
    try {
      await refreshRestaurantAffinity(supabaseAdmin, t.id, { lookbackDays });
      refreshed += 1;
    } catch (err) {
      failed += 1;
      console.warn(`[product-affinity] refresh failed for ${t.id}:`, err.message);
    }
  }
  return { refreshed, failed, total: (tenants || []).length };
}

async function readCachedAffinity(supabaseAdmin, restaurantId) {
  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select('product_affinity')
    .eq('id', restaurantId)
    .maybeSingle();
  if (error) throw error;
  const cache = data?.product_affinity;
  if (cache && typeof cache === 'object' && !Array.isArray(cache)) return cache;
  return null;
}

/**
 * RFM-style personal favourites from this customer's recent orders.
 * Used to bias "also bought" toward what they already repurchase.
 */
async function getCustomerFavouriteNames(supabaseAdmin, restaurantId, phone, { limit = 8, lookbackDays = 180 } = {}) {
  const variants = phoneVariants(phone);
  const last10 = normPhone(phone);
  if (!variants.length && !last10) return [];

  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  let query = supabaseAdmin
    .from('orders')
    .select('id, customer_phone')
    .eq('restaurant_id', restaurantId)
    .gte('created_at', since)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(40);

  if (variants.length) {
    query = query.in('customer_phone', variants);
  } else {
    return [];
  }

  const { data: orders, error } = await query;
  if (error) {
    console.warn('[product-affinity] customer favourites:', error.message);
    return [];
  }

  const orderIds = (orders || []).map((o) => o.id).filter(Boolean);
  if (!orderIds.length) return [];

  const { orderItems } = await fetchOrderRevenueById(supabaseAdmin, orderIds, {
    restaurantId,
    phone: last10,
  });

  const counts = {};
  for (const row of orderItems) {
    const name = extractItemName(row);
    if (!name) continue;
    const qty = Number(row.quantity) || 1;
    counts[name] = (counts[name] || 0) + qty;
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, qty]) => ({ name, qty }));
}

/**
 * Ensure cache is fresh, then return payload for webcart (global + personal).
 * Stale caches are returned immediately; refresh runs in the background.
 */
async function getAffinityForWebcart(supabaseAdmin, restaurantId, { phone = null, forceRefresh = false } = {}) {
  let cache = null;
  try {
    cache = await readCachedAffinity(supabaseAdmin, restaurantId);
  } catch (err) {
    console.warn('[product-affinity] read cache:', err.message);
  }

  const needsRefresh = forceRefresh || !isCacheFresh(cache);
  if (needsRefresh) {
    if (!cache || forceRefresh) {
      // First visit / forced: wait so the cart has something to recommend.
      try {
        cache = await refreshRestaurantAffinity(supabaseAdmin, restaurantId);
      } catch (err) {
        console.warn('[product-affinity] refresh:', err.message);
      }
    } else {
      // Stale-but-present: serve now, refresh in background for next session.
      refreshRestaurantAffinity(supabaseAdmin, restaurantId).catch((err) => {
        console.warn('[product-affinity] background refresh:', err.message);
      });
    }
  }

  let customer_favourites = [];
  if (phone) {
    try {
      customer_favourites = await getCustomerFavouriteNames(supabaseAdmin, restaurantId, phone);
    } catch (err) {
      console.warn('[product-affinity] favourites:', err.message);
    }
  }

  return {
    updated_at: cache?.updated_at || null,
    lookback_days: cache?.lookback_days || DEFAULT_LOOKBACK_DAYS,
    order_count: cache?.order_count || 0,
    by_item: cache?.by_item || {},
    pairs: cache?.pairs || [],
    customer_favourites,
  };
}

module.exports = {
  computeAffinityFromOrders,
  refreshRestaurantAffinity,
  refreshAllAffinities,
  getAffinityForWebcart,
  getCustomerFavouriteNames,
  isCacheFresh,
  STALE_MS,
  DEFAULT_LOOKBACK_DAYS,
};
