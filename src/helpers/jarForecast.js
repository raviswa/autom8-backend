'use strict';

/**
 * Tier-1 jar demand forecast from recent order history (no BOM required).
 *
 * Forecasting off a single order would confidently mislead a maker into
 * over-producing — so a forecast_units number is only returned once an item
 * clears a minimum spread of real orders/days; otherwise it's marked
 * low-confidence with forecast_units: null so callers can show "not enough
 * data yet" instead of a fabricated number.
 */

const MIN_ORDERS_FOR_CONFIDENCE = 5;
const MIN_DISTINCT_DAYS_FOR_CONFIDENCE = 7;

async function forecastJarDemand(supabaseAdmin, restaurantId, { lookbackDays = 30, horizonDays = 30 } = {}) {
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const { data: orders, error } = await supabaseAdmin
    .from('orders')
    .select('id, created_at')
    .eq('restaurant_id', restaurantId)
    .gte('created_at', since)
    .neq('status', 'cancelled')
    .limit(2000);
  if (error) throw error;
  const orderRows = orders || [];
  if (!orderRows.length) {
    return { lookback_days: lookbackDays, horizon_days: horizonDays, items: [], insufficient_data: true };
  }
  const orderIds = orderRows.map((o) => o.id);
  const orderDateById = new Map(orderRows.map((o) => [String(o.id), String(o.created_at || '').slice(0, 10)]));

  const { fetchOrderRevenueById, extractItemName } = require('./dashboardAnalytics');
  const { orderItems } = await fetchOrderRevenueById(supabaseAdmin, orderIds, { restaurantId });

  const counts = {};
  const orderSetsByName = {};
  const daySetsByName = {};
  for (const row of orderItems) {
    const name = extractItemName(row);
    if (!name) continue;
    counts[name] = (counts[name] || 0) + (Number(row.quantity) || 1);
    (orderSetsByName[name] ||= new Set()).add(String(row.order_id));
    const day = orderDateById.get(String(row.order_id));
    if (day) (daySetsByName[name] ||= new Set()).add(day);
  }

  const scale = horizonDays / Math.max(1, lookbackDays);
  const items = Object.entries(counts)
    .map(([name, qty]) => {
      const orderCount = orderSetsByName[name]?.size || 0;
      const distinctDays = daySetsByName[name]?.size || 0;
      const confident = orderCount >= MIN_ORDERS_FOR_CONFIDENCE && distinctDays >= MIN_DISTINCT_DAYS_FOR_CONFIDENCE;
      return {
        name,
        sold_lookback: qty,
        order_count: orderCount,
        distinct_days: distinctDays,
        confidence: confident ? 'ok' : 'low',
        forecast_units: confident ? Math.max(1, Math.round(qty * scale * 1.1)) : null,
      };
    })
    .sort((a, b) => (b.forecast_units ?? 0) - (a.forecast_units ?? 0) || b.sold_lookback - a.sold_lookback)
    .slice(0, 20);

  return { lookback_days: lookbackDays, horizon_days: horizonDays, items };
}

module.exports = { forecastJarDemand };
