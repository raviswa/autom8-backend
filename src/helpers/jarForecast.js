'use strict';

/**
 * Tier-1 jar demand forecast from recent order history (no BOM required).
 */

async function forecastJarDemand(supabaseAdmin, restaurantId, { lookbackDays = 30, horizonDays = 30 } = {}) {
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const { data: orders, error } = await supabaseAdmin
    .from('orders')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .gte('created_at', since)
    .neq('status', 'cancelled')
    .limit(2000);
  if (error) throw error;
  const orderIds = (orders || []).map((o) => o.id);
  if (!orderIds.length) return { lookback_days: lookbackDays, horizon_days: horizonDays, items: [] };

  const { fetchOrderRevenueById, extractItemName } = require('./dashboardAnalytics');
  const { orderItems } = await fetchOrderRevenueById(supabaseAdmin, orderIds, { restaurantId });

  const counts = {};
  for (const row of orderItems) {
    const name = extractItemName(row);
    if (!name) continue;
    counts[name] = (counts[name] || 0) + (Number(row.quantity) || 1);
  }

  const scale = horizonDays / Math.max(1, lookbackDays);
  const items = Object.entries(counts)
    .map(([name, qty]) => ({
      name,
      sold_lookback: qty,
      forecast_units: Math.max(1, Math.round(qty * scale * 1.1)),
    }))
    .sort((a, b) => b.forecast_units - a.forecast_units)
    .slice(0, 20);

  return { lookback_days: lookbackDays, horizon_days: horizonDays, items };
}

module.exports = { forecastJarDemand };
