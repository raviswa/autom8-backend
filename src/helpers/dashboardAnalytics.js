'use strict';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const ORDER_TOKEN_MATCH_MS = 7 * 24 * 60 * 60 * 1000;
const WHATSAPP_SOURCES = new Set([
  'whatsapp_booking', 'whatsapp', 'dine_in', 'takeaway', 'delivery',
  'reserve_table', 'dinein',
]);

function normPhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

function toISTDate(iso) {
  return new Date(new Date(iso).getTime() + IST_OFFSET_MS);
}

function channelFromSource(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('delivery')) return 'delivery';
  if (s.includes('takeaway')) return 'takeaway';
  if (s.includes('dine')) return 'dine_in';
  return 'other';
}

function isWhatsappSource(source) {
  const s = String(source || '').toLowerCase();
  return WHATSAPP_SOURCES.has(s) || s.includes('whatsapp');
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function istDateKey(iso) {
  const ist = toISTDate(iso);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function summarizeSupabaseError(error) {
  if (!error) return null;
  return {
    message: error.message || null,
    details: error.details || null,
    hint: error.hint || null,
    code: error.code || null,
  };
}

function logSupabaseError(scope, error, context = {}) {
  console.error(`[dashboard/insights] ${scope} failed`, {
    ...context,
    error: summarizeSupabaseError(error),
  });
}

function buildRevenueHeatmap(orders, endISO, orderRevenueById = {}) {
  const days = [
    { key: 1, label: 'Mon', dow: 'Mon' },
    { key: 2, label: 'Tue', dow: 'Tue' },
    { key: 3, label: 'Wed', dow: 'Wed' },
    { key: 4, label: 'Thu', dow: 'Thu' },
    { key: 5, label: 'Fri', dow: 'Fri' },
    { key: 6, label: 'Sat', dow: 'Sat' },
    { key: 0, label: 'Sun', dow: 'Sun' },
  ];

  const dayIndex = Object.fromEntries(days.map((d, i) => [d.key, i]));
  const revenueSum = Array.from({ length: 7 }, () => Array(24).fill(0));
  const orderCount = Array.from({ length: 7 }, () => Array(24).fill(0));
  const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));

  let max = 0;
  let revenueOrderCount = 0;
  let totalOrders = 0;

  for (const o of orders) {
    if (!o.created_at || o.status === 'cancelled') continue;
    const ist = toISTDate(o.created_at);
    const di = dayIndex[ist.getUTCDay()];
    if (di == null) continue;

    const hour = ist.getUTCHours();
    const rev = Number(o.total_amount) > 0
      ? Number(o.total_amount)
      : Number(orderRevenueById[o.id]) || 0;

    totalOrders += 1;
    orderCount[di][hour] += 1;
    if (rev > 0) {
      revenueSum[di][hour] += rev;
      revenueOrderCount += 1;
    }
  }

  // Prefer average revenue when enough totals exist; otherwise show order density
  // so the heatmap is not blank when total_amount is sparsely captured.
  const useOrderCount = totalOrders > 0 && revenueOrderCount < Math.ceil(totalOrders * 0.5);
  const aggregation = useOrderCount ? 'order_count' : 'average_revenue_per_order';

  for (let di = 0; di < 7; di++) {
    for (let h = 0; h < 24; h++) {
      const value = useOrderCount
        ? orderCount[di][h]
        : (orderCount[di][h] > 0 ? (revenueSum[di][h] / orderCount[di][h]) : 0);
      matrix[di][h] = Math.round(value);
      if (matrix[di][h] > max) max = matrix[di][h];
    }
  }

  // Attach calendar labels for the trailing 7 IST days ending at endISO.
  const endIst = toISTDate(endISO || new Date().toISOString());
  const labeledDays = days.map((d, di) => {
    const offsetFromEnd = (endIst.getUTCDay() - d.key + 7) % 7;
    const dayDate = new Date(endIst.getTime() - offsetFromEnd * 86400000);
    const y = dayDate.getUTCFullYear();
    const m = String(dayDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dayDate.getUTCDate()).padStart(2, '0');
    return {
      ...d,
      date: `${y}-${m}-${day}`,
      label: `${Number(day)} ${dayDate.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`,
    };
  });

  const peaks = [];
  for (let di = 0; di < 7; di++) {
    for (let h = 0; h < 24; h++) {
      if (matrix[di][h] > 0) {
        peaks.push({
          dayIndex: di,
          hour: h,
          revenue: matrix[di][h],
          label: `${labeledDays[di].dow} ${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`,
        });
      }
    }
  }

  peaks.sort((a, b) => b.revenue - a.revenue);

  return {
    days: labeledDays,
    hours: Array.from({ length: 24 }, (_, i) => i),
    matrix,
    max: Math.round(max),
    peaks: peaks.slice(0, 5),
    aggregation,
  };
}

function buildServiceSplit(orders) {
  const buckets = {
    dine_in: { revenue: 0, orderCount: 0, revenueOrderCount: 0, missingAmountCount: 0 },
    takeaway: { revenue: 0, orderCount: 0, revenueOrderCount: 0, missingAmountCount: 0 },
    delivery: { revenue: 0, orderCount: 0, revenueOrderCount: 0, missingAmountCount: 0 },
    other: { revenue: 0, orderCount: 0, revenueOrderCount: 0, missingAmountCount: 0 },
  };
  let whatsappRevenue = 0;
  let whatsappOrderCount = 0;
  let totalRevenue = 0;
  let totalOrders = 0;
  let revenueOrderCount = 0;

  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    const sourceHint = o.service_type || o.source;
    const ch = channelFromSource(sourceHint);
    const bucket = buckets[ch] || buckets.other;
    const rev = Number(o.total_amount) || 0;
    const hasRevenue = rev > 0;

    bucket.orderCount += 1;
    totalOrders += 1;
    if (o.token_id || isWhatsappSource(o.source)) whatsappOrderCount += 1;

    if (hasRevenue) {
      bucket.revenue += rev;
      bucket.revenueOrderCount += 1;
      totalRevenue += rev;
      revenueOrderCount += 1;
      if (o.token_id || isWhatsappSource(o.source)) whatsappRevenue += rev;
    } else {
      bucket.missingAmountCount += 1;
    }
  }

  const missingAmountCount = Math.max(0, totalOrders - revenueOrderCount);
  const useOrderCountMode = totalOrders > 0 && revenueOrderCount < Math.ceil(totalOrders * 0.5);
  const mode = useOrderCountMode ? 'order_count' : 'revenue';
  const metricLabel = useOrderCountMode ? 'by order count' : 'by revenue';
  const total = useOrderCountMode ? totalOrders : totalRevenue;
  const whatsappValue = useOrderCountMode ? whatsappOrderCount : whatsappRevenue;

  const channels = [
    { key: 'dine_in', label: 'Dine-in' },
    { key: 'takeaway', label: 'Takeaway' },
    { key: 'delivery', label: 'Delivery' },
    { key: 'other', label: 'In-restaurant / POS' },
  ];

  return {
    mode,
    metricLabel,
    total: Math.round(total),
    totalRevenue: Math.round(totalRevenue),
    totalOrderCount: totalOrders,
    revenueOrderCount,
    missingAmountCount,
    whatsappRevenue: Math.round(whatsappRevenue),
    whatsappOrderCount,
    whatsappValue: Math.round(whatsappValue),
    whatsappPct: total > 0 ? Math.round((whatsappValue / total) * 100) : 0,
    channels: channels.map(c => ({
      channel: c.key,
      label: c.label,
      revenue: Math.round(useOrderCountMode ? buckets[c.key].orderCount : buckets[c.key].revenue),
      actualRevenue: Math.round(buckets[c.key].revenue),
      orderCount: buckets[c.key].orderCount,
      value: Math.round(useOrderCountMode ? buckets[c.key].orderCount : buckets[c.key].revenue),
      pct: total > 0 ? Math.round((((useOrderCountMode ? buckets[c.key].orderCount : buckets[c.key].revenue) || 0) / total) * 100) : 0,
      revenueOrderCount: buckets[c.key].revenueOrderCount,
      missingAmountCount: buckets[c.key].missingAmountCount,
    })).filter(c => c.value > 0),
  };
}

function buildRepeatTrend(orders) {
  const byPhone = {};
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    const phone = normPhone(o.customer_phone);
    if (!phone || !o.created_at) continue;
    if (!byPhone[phone]) byPhone[phone] = [];
    byPhone[phone].push(new Date(o.created_at).getTime());
  }

  const weekMap = {};
  for (const times of Object.values(byPhone)) {
    times.sort((a, b) => a - b);
    for (let i = 0; i < times.length; i++) {
      const d = new Date(times[i]);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      weekStart.setHours(0, 0, 0, 0);
      const key = weekStart.toISOString().slice(0, 10);
      if (!weekMap[key]) weekMap[key] = { new: 0, returning: 0 };
      const hadPrior = i > 0;
      if (hadPrior) weekMap[key].returning += 1;
      else weekMap[key].new += 1;
    }
  }

  return Object.entries(weekMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, v]) => {
      const total = v.new + v.returning;
      return {
        week,
        newCustomers: v.new,
        returningCustomers: v.returning,
        returningPct: total > 0 ? Math.round((v.returning / total) * 100) : 0,
      };
    });
}

function nearestTokenForOrder(order, tokens, {
  phoneKey = null,
  windowMs = ORDER_TOKEN_MATCH_MS,
  excludeTokenIds = null,
} = {}) {
  if (!order?.created_at || !tokens?.length) return null;
  const orderTs = new Date(order.created_at).getTime();
  let candidates = tokens;
  if (phoneKey) {
    const byPhone = tokens.filter(t => normPhone(t.phone) === phoneKey);
    if (byPhone.length) candidates = byPhone;
  }
  let best = null;
  let bestDist = Infinity;
  for (const t of candidates) {
    if (!t?.arrived_at) continue;
    if (excludeTokenIds?.has(t.id)) continue;
    const dist = Math.abs(new Date(t.arrived_at).getTime() - orderTs);
    if (dist <= windowMs && dist < bestDist) {
      bestDist = dist;
      best = t;
    }
  }
  return best;
}

function resolveOrderGuest(order, tokens, tokenPhoneById, tokenNameById) {
  let phone = order.customer_phone || tokenPhoneById[order.token_id] || null;
  let name = order.customer_name || tokenNameById[order.token_id] || null;
  if (phone) return { phone, name };

  const phoneKey = normPhone(order.customer_phone);
  const matched = nearestTokenForOrder(order, tokens, { phoneKey: phoneKey || null });
  if (matched) {
    return {
      phone: matched.phone || phone,
      name: name || matched.name || null,
      tokenId: matched.id,
    };
  }
  return { phone: null, name };
}

function buildCustomerInsights(orders, tokens, orderRevenueById = {}) {
  const customers = {};
  const tokenPhoneById = Object.fromEntries(
    (tokens || []).map(t => [t.id, normPhone(t.phone)]).filter(([, p]) => Boolean(p))
  );
  const tokenNameById = Object.fromEntries(
    (tokens || []).map(t => [t.id, t.name || null]).filter(([, n]) => Boolean(n))
  );

  const touch = (phone, name, ts, amount, { countVisit = true } = {}) => {
    const p = normPhone(phone);
    if (!p) return;
    if (!customers[p]) {
      customers[p] = { phone: p, name: name || null, visits: [], spend: 0 };
    }
    if (name && !customers[p].name) customers[p].name = name;
    if (countVisit && ts) customers[p].visits.push(new Date(ts).getTime());
    if (amount) customers[p].spend += Number(amount) || 0;
  };

  // Prefer token sessions as the visit source (one visit per token).
  for (const t of tokens || []) {
    touch(t.phone, t.name, t.arrived_at, null, { countVisit: true });
  }

  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    const amount = Number(o.total_amount) > 0
      ? Number(o.total_amount)
      : Number(orderRevenueById[o.id]) || 0;
    const guest = resolveOrderGuest(o, tokens, tokenPhoneById, tokenNameById);
    const linkedViaToken = Boolean(o.token_id && tokenPhoneById[o.token_id]);
    // Spend attaches to the guest; do not double-count visits already recorded via tokens.
    touch(
      guest.phone,
      guest.name,
      o.created_at,
      amount,
      { countVisit: !linkedViaToken && !guest.tokenId },
    );
  }

  // Deduplicate near-simultaneous visit stamps (token + order within 90 minutes).
  for (const c of Object.values(customers)) {
    c.visits.sort((a, b) => a - b);
    const deduped = [];
    for (const ts of c.visits) {
      if (!deduped.length || (ts - deduped[deduped.length - 1]) > 90 * 60 * 1000) {
        deduped.push(ts);
      }
    }
    c.visits = deduped;
  }

  const now = Date.now();
  const DAY = 86400000;
  let segments = { active: 0, atRisk: 0, lapsed: 0 };
  const gaps = [];

  for (const c of Object.values(customers)) {
    c.visits.sort((a, b) => a - b);
    c.visitCount = c.visits.length;
    c.lastVisit = c.visits.length ? c.visits[c.visits.length - 1] : null;
    const daysSince = c.lastVisit ? Math.floor((now - c.lastVisit) / DAY) : 999;
    c.daysSinceLastVisit = daysSince;

    if (daysSince <= 14) segments.active += 1;
    else if (daysSince <= 45) segments.atRisk += 1;
    else segments.lapsed += 1;

    if (c.visits.length >= 2) {
      for (let i = 1; i < c.visits.length; i++) {
        gaps.push((c.visits[i] - c.visits[i - 1]) / DAY);
      }
    }
  }

  const list = Object.values(customers).filter(c => c.visitCount > 0);
  const topByVisits = [...list]
    .sort((a, b) => b.visitCount - a.visitCount || b.spend - a.spend)
    .slice(0, 10)
    .map(c => ({
      name: c.name || 'Guest',
      phone: c.phone,
      visits: c.visitCount,
      spend: Math.round(c.spend),
      lastVisit: c.lastVisit ? new Date(c.lastVisit).toISOString() : null,
      daysSinceLastVisit: c.daysSinceLastVisit,
    }));

  const topBySpend = [...list]
    .sort((a, b) => b.spend - a.spend || b.visitCount - a.visitCount)
    .slice(0, 10)
    .map(c => ({
      name: c.name || 'Guest',
      phone: c.phone,
      visits: c.visitCount,
      spend: Math.round(c.spend),
      lastVisit: c.lastVisit ? new Date(c.lastVisit).toISOString() : null,
      daysSinceLastVisit: c.daysSinceLastVisit,
    }));

  return {
    totalCustomers: list.length,
    avgDaysBetweenVisits: gaps.length ? Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length) : null,
    medianDaysBetweenVisits: gaps.length ? Math.round(median(gaps)) : null,
    segments,
    topByVisits,
    topBySpend,
  };
}

function buildStockOutages(auditRows) {
  const byItem = {};
  const events = (auditRows ?? [])
    .filter(r => /marked (in|out)(?: of)? stock/i.test(r.action || ''))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  for (const ev of events) {
    const name = ev.details?.item_name || ev.details?.name || 'Unknown';
    if (!byItem[name]) byItem[name] = { name, offCount: 0, totalOffMinutes: 0, lastOffAt: null, openSince: null };
    const row = byItem[name];
    const isOff = /out of stock/i.test(ev.action);
    const ts = new Date(ev.created_at).getTime();

    if (isOff) {
      row.offCount += 1;
      row.lastOffAt = ev.created_at;
      row.openSince = ts;
    } else if (row.openSince) {
      row.totalOffMinutes += Math.round((ts - row.openSince) / 60000);
      row.openSince = null;
    }
  }

  return Object.values(byItem)
    .filter(r => r.offCount > 0)
    .sort((a, b) => b.offCount - a.offCount || b.totalOffMinutes - a.totalOffMinutes)
    .slice(0, 15)
    .map(r => ({
      name: r.name,
      offCount: r.offCount,
      totalOffHours: Math.round(r.totalOffMinutes / 60 * 10) / 10,
      lastOffAt: r.lastOffAt,
    }));
}

function extractItemName(row) {
  const fromMenu = row?.menu_item?.name;
  const fromItemName = row?.item_name;
  const fromSpecial = row?.special_instructions;
  const name = fromMenu || fromItemName || fromSpecial || '';
  const clean = String(name).trim();
  return clean || null;
}

/** Co-purchase index used by OwnerInsights + webcart affinity recommendations. */
function buildAffinityIndex(orderItems, { minPairCount = 2, topPartners = 8, topPairs = 12 } = {}) {
  const byOrder = {};
  for (const row of orderItems) {
    const oid = row.order_id;
    const name = extractItemName(row);
    if (!oid || !name) continue;
    if (!byOrder[oid]) byOrder[oid] = new Set();
    byOrder[oid].add(name);
  }

  const pairCount = {};
  const directed = {};
  for (const items of Object.values(byOrder)) {
    const arr = [...items];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i];
        const b = arr[j];
        const key = [a, b].sort().join(' + ');
        pairCount[key] = (pairCount[key] || 0) + 1;
        if (!directed[a]) directed[a] = {};
        if (!directed[b]) directed[b] = {};
        directed[a][b] = (directed[a][b] || 0) + 1;
        directed[b][a] = (directed[b][a] || 0) + 1;
      }
    }
  }

  const pairs = Object.entries(pairCount)
    .filter(([, n]) => n >= minPairCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topPairs)
    .map(([pair, count]) => {
      const [itemA, itemB] = pair.split(' + ');
      return { itemA, itemB, count, label: pair };
    });

  const by_item = {};
  for (const [item, partners] of Object.entries(directed)) {
    by_item[item] = Object.entries(partners)
      .filter(([, n]) => n >= minPairCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topPartners)
      .map(([name, count]) => ({ name, count }));
  }

  return {
    pairs,
    by_item,
    order_basket_count: Object.keys(byOrder).length,
  };
}

function buildComboPatterns(orderItems) {
  return buildAffinityIndex(orderItems).pairs;
}

function buildMenuQuadrant(orderItems) {
  const map = {};
  for (const row of orderItems) {
    const name = extractItemName(row);
    if (!name) continue;
    if (!map[name]) map[name] = { name, qty: 0, revenue: 0 };
    const q = row.quantity ?? 1;
    const price = Number(row.unit_price ?? row.menu_item?.price ?? 0);
    map[name].qty += q;
    map[name].revenue += q * price;
  }

  const items = Object.values(map).map(i => ({
    name: i.name,
    qty: i.qty,
    revenue: Math.round(i.revenue * 100) / 100,
  }));

  if (!items.length) return {
    items: [],
    medians: { qty: 0, revenue: 0 },
    mode: 'revenue_popularity_fallback',
    unavailableReason: 'No item sales in selected period',
  };

  const medQty = median(items.map(i => i.qty));
  const medRev = median(items.map(i => i.revenue));

  for (const i of items) {
    const highQty = i.qty >= medQty;
    const highRev = i.revenue >= medRev;
    if (highQty && highRev) i.quadrant = 'star';
    else if (!highQty && highRev) i.quadrant = 'hidden_gem';
    else if (highQty && !highRev) i.quadrant = 'filler';
    else i.quadrant = 'dead_weight';
  }

  return {
    items: items.sort((a, b) => b.revenue - a.revenue),
    medians: { qty: Math.round(medQty), revenue: Math.round(medRev) },
    mode: 'revenue_popularity_fallback',
  };
}

async function fetchOrderRevenueById(supabaseAdmin, orderIds, context = {}) {
  const orderItems = [];
  const orderRevenueById = {};
  if (!orderIds?.length) return { orderItems, orderRevenueById };

  const CHUNK = 150;
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const chunk = orderIds.slice(i, i + CHUNK);
    let oiData = [];
    const primaryItems = await supabaseAdmin.from('order_items')
      .select('order_id, quantity, unit_price, special_instructions, menu_item:menu_item_id(name, price)')
      .in('order_id', chunk);

    if (!primaryItems.error) {
      oiData = primaryItems.data ?? [];
    } else {
      logSupabaseError('order_items.primary', primaryItems.error, {
        ...context,
        chunkLength: chunk.length,
        chunkSample: chunk.slice(0, 5),
      });
      const fallbackItems = await supabaseAdmin.from('order_items')
        .select('order_id, quantity, unit_price, special_instructions, menu_item:menu_item_id(name)')
        .in('order_id', chunk);
      if (fallbackItems.error) {
        logSupabaseError('order_items.fallback', fallbackItems.error, {
          ...context,
          chunkLength: chunk.length,
          chunkSample: chunk.slice(0, 5),
        });
        oiData = [];
      } else {
        oiData = (fallbackItems.data ?? []).map(r => ({ ...r, menu_item: null, item_name: null }));
      }
    }

    if (!oiData.length) continue;
    orderItems.push(...oiData);
    for (const row of oiData) {
      const qty = Number(row.quantity) || 0;
      const price = Number(row.unit_price ?? row.menu_item?.price) || 0;
      const rev = qty * price;
      if (!row.order_id || rev <= 0) continue;
      orderRevenueById[row.order_id] = (orderRevenueById[row.order_id] || 0) + rev;
    }
  }

  return { orderItems, orderRevenueById };
}

function enrichOrdersWithRevenue(orders, orderRevenueById) {
  return orders.map(o => {
    const captured = Number(o.total_amount) || 0;
    if (captured > 0) return o;
    const fromItems = Number(orderRevenueById[o.id]) || 0;
    return fromItems > 0 ? { ...o, total_amount: fromItems } : o;
  });
}

function buildTopMenuItems(orderItems, limit = 7) {
  const map = {};
  for (const row of orderItems) {
    const name = extractItemName(row);
    if (!name) continue;
    if (!map[name]) map[name] = { name, qty: 0, revenue: 0 };
    const qty = Number(row.quantity) || 1;
    const price = Number(row.unit_price ?? row.menu_item?.price) || 0;
    map[name].qty += qty;
    map[name].revenue += qty * price;
  }
  return Object.values(map)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

function buildRevenueTrend(orders, preset = '30d') {
  const byLabel = {};
  const hourly = preset === 'today' || preset === 'yesterday';
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  for (const o of orders) {
    if (!o.created_at || o.status === 'cancelled') continue;
    const ist = toISTDate(o.created_at);
    const label = hourly
      ? `${ist.getUTCHours()}:00`
      : `${String(ist.getUTCDate()).padStart(2, '0')} ${monthNames[ist.getUTCMonth()]}`;
    if (!byLabel[label]) {
      byLabel[label] = {
        revenue: 0,
        orders: 0,
        covers: 0,
        sortKey: hourly ? ist.getUTCHours() : ist.getTime(),
      };
    }
    byLabel[label].revenue += Number(o.total_amount) || 0;
    byLabel[label].orders += 1;
    byLabel[label].covers += 1;
  }

  const labels = Object.keys(byLabel).sort((a, b) => byLabel[a].sortKey - byLabel[b].sortKey);
  return {
    labels,
    revenue: labels.map(l => Math.round(byLabel[l].revenue * 100) / 100),
    orders: labels.map(l => byLabel[l].orders),
    covers: labels.map(l => byLabel[l].covers),
  };
}

function buildPeriodSummary(enrichedOrders, tokens) {
  const activeOrders = enrichedOrders.filter(o => o.status !== 'cancelled');
  const totalRevenue = activeOrders.reduce((s, o) => s + (Number(o.total_amount) || 0), 0);
  const totalOrders = activeOrders.length;
  const tokenRows = tokens ?? [];
  const seated = tokenRows.filter(t => t.seated_at && t.arrived_at);
  const avgWait = seated.length
    ? Math.round(seated.reduce((s, t) => s + (new Date(t.seated_at) - new Date(t.arrived_at)) / 60000, 0) / seated.length)
    : null;
  const completed = tokenRows.filter(t => t.seated_at && t.completed_at);
  const avgDining = completed.length
    ? Math.round(completed.reduce((s, t) => s + (new Date(t.completed_at) - new Date(t.seated_at)) / 60000, 0) / completed.length)
    : null;

  return {
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalOrders,
    aov: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0,
    totalCovers: totalOrders,
    tokensIssued: tokenRows.length,
    avgDining,
    avgWait,
  };
}

async function computeDashboardInsights(supabaseAdmin, restaurantId, startISO, endISO, preset = '30d') {
  let orders = [];
  const primaryOrders = await supabaseAdmin.from('orders')
    .select('id, created_at, total_amount, status, source, service_type, token_id, customer_phone, customer_name')
    .eq('restaurant_id', restaurantId)
    .gte('created_at', startISO).lte('created_at', endISO)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: true });

  if (!primaryOrders.error) {
    orders = primaryOrders.data ?? [];
  } else {
    logSupabaseError('orders.primary', primaryOrders.error, {
      restaurantId,
      startISO,
      endISO,
    });
    const fallbackOrders = await supabaseAdmin.from('orders')
      .select('id, created_at, total_amount, status, source, customer_phone, customer_name')
      .eq('restaurant_id', restaurantId)
      .gte('created_at', startISO).lte('created_at', endISO)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: true });
    if (fallbackOrders.error) {
      logSupabaseError('orders.fallback', fallbackOrders.error, {
        restaurantId,
        startISO,
        endISO,
      });
      orders = [];
    } else {
      orders = (fallbackOrders.data ?? []).map(o => ({ ...o, token_id: null, service_type: null }));
    }
  }

  const [tokensRes, auditRes] = await Promise.all([
    supabaseAdmin.from('walk_in_tokens')
      .select('id, phone, name, arrived_at, status, seated_at, completed_at')
      .eq('restaurant_id', restaurantId)
      .gte('arrived_at', startISO).lte('arrived_at', endISO),
    supabaseAdmin.from('audit_logs')
      .select('action, details, created_at')
      .eq('restaurant_id', restaurantId)
      .gte('created_at', startISO).lte('created_at', endISO)
      .or('action.ilike.%stock%,action.ilike.%Stock%'),
  ]);

  if (tokensRes.error) {
    logSupabaseError('walk_in_tokens', tokensRes.error, {
      restaurantId,
      startISO,
      endISO,
    });
  }
  if (auditRes.error) {
    logSupabaseError('audit_logs', auditRes.error, {
      restaurantId,
      startISO,
      endISO,
    });
  }

  const orderIds = orders.map(o => o.id).filter(Boolean);
  const { orderItems, orderRevenueById } = await fetchOrderRevenueById(
    supabaseAdmin,
    orderIds,
    { restaurantId, startISO, endISO },
  );

  const stockOutages = buildStockOutages(auditRes.data);

  // Backfill missing order totals from line items so revenue-derived panels
  // (heatmap, service split, customer spend) degrade gracefully.
  const enrichedOrders = enrichOrdersWithRevenue(orders, orderRevenueById);
  const tokens = tokensRes.data ?? [];

  return {
    summary: buildPeriodSummary(enrichedOrders, tokens),
    revenueTrend: buildRevenueTrend(enrichedOrders, preset),
    topMenuItems: buildTopMenuItems(orderItems),
    revenueHeatmap: buildRevenueHeatmap(enrichedOrders, endISO, orderRevenueById),
    serviceSplit: buildServiceSplit(enrichedOrders),
    repeatTrend: buildRepeatTrend(enrichedOrders),
    customers: buildCustomerInsights(enrichedOrders, tokens, orderRevenueById),
    stockOutages,
    stockOutagesMeta: {
      source: 'audit_logs',
      instrumented: true,
      eventCount: (auditRes.data ?? []).length,
    },
    comboPatterns: buildComboPatterns(orderItems),
    menuQuadrant: buildMenuQuadrant(orderItems),
  };
}

module.exports = {
  computeDashboardInsights,
  fetchOrderRevenueById,
  enrichOrdersWithRevenue,
  nearestTokenForOrder,
  normPhone,
  channelFromSource,
  buildAffinityIndex,
  buildComboPatterns,
  extractItemName,
  ORDER_TOKEN_MATCH_MS,
};
