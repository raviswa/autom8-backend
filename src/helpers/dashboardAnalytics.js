'use strict';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
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

function buildRevenueHeatmap(orders, endISO) {
  const end = new Date(endISO);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    const date = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
    days.push({
      date,
      label: ist.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' }),
      dow: ist.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' }),
    });
  }
  const dayIndex = Object.fromEntries(days.map((d, i) => [d.date, i]));
  const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;

  for (const o of orders) {
    if (!o.created_at || o.status === 'cancelled') continue;
    const ist = toISTDate(o.created_at);
    const dateKey = istDateKey(o.created_at);
    const idx = dayIndex[dateKey];
    if (idx === undefined) continue;
    const hour = ist.getUTCHours();
    const rev = Number(o.total_amount) || 0;
    matrix[idx][hour] += rev;
    if (matrix[idx][hour] > max) max = matrix[idx][hour];
  }

  const peaks = [];
  for (let di = 0; di < 7; di++) {
    for (let h = 0; h < 24; h++) {
      if (matrix[di][h] > 0) {
        peaks.push({
          dayIndex: di,
          hour: h,
          revenue: Math.round(matrix[di][h]),
          label: `${days[di].dow} ${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`,
        });
      }
    }
  }
  peaks.sort((a, b) => b.revenue - a.revenue);

  return { days, hours: Array.from({ length: 24 }, (_, i) => i), matrix, max: Math.round(max), peaks: peaks.slice(0, 5) };
}

function buildServiceSplit(orders) {
  const buckets = { dine_in: 0, takeaway: 0, delivery: 0, other: 0 };
  let whatsappRevenue = 0;
  let total = 0;

  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    const rev = Number(o.total_amount) || 0;
    if (rev <= 0) continue;
    const ch = channelFromSource(o.source);
    buckets[ch] = (buckets[ch] || 0) + rev;
    total += rev;
    if (isWhatsappSource(o.source)) whatsappRevenue += rev;
  }

  // Fix double-count for other channel
  const channels = [
    { key: 'dine_in', label: 'Dine-in' },
    { key: 'takeaway', label: 'Takeaway' },
    { key: 'delivery', label: 'Delivery' },
    { key: 'other', label: 'In-restaurant / POS' },
  ];

  return {
    total: Math.round(total),
    whatsappRevenue: Math.round(whatsappRevenue),
    whatsappPct: total > 0 ? Math.round((whatsappRevenue / total) * 100) : 0,
    channels: channels.map(c => ({
      channel: c.key,
      label: c.label,
      revenue: Math.round(buckets[c.key] || 0),
      pct: total > 0 ? Math.round(((buckets[c.key] || 0) / total) * 100) : 0,
    })).filter(c => c.revenue > 0),
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

function buildCustomerInsights(orders, tokens) {
  const customers = {};

  const touch = (phone, name, ts, amount) => {
    const p = normPhone(phone);
    if (!p) return;
    if (!customers[p]) {
      customers[p] = { phone: p, name: name || null, visits: [], spend: 0 };
    }
    if (name && !customers[p].name) customers[p].name = name;
    if (ts) customers[p].visits.push(new Date(ts).getTime());
    if (amount) customers[p].spend += Number(amount) || 0;
  };

  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    touch(o.customer_phone, o.customer_name, o.created_at, o.total_amount);
  }
  for (const t of tokens) {
    touch(t.phone, t.name, t.arrived_at, null);
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
    .filter(r => /marked (in|out) stock/i.test(r.action || ''))
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
    .sort((a, b) => b.offCount - a.offCount || b.totalOffMinutes - a.totalOffMinutes)
    .slice(0, 15)
    .map(r => ({
      name: r.name,
      offCount: r.offCount,
      totalOffHours: Math.round(r.totalOffMinutes / 60 * 10) / 10,
      lastOffAt: r.lastOffAt,
    }));
}

function buildComboPatterns(orderItems) {
  const byOrder = {};
  for (const row of orderItems) {
    const oid = row.order_id;
    const name = row.menu_item?.name;
    if (!oid || !name) continue;
    if (!byOrder[oid]) byOrder[oid] = new Set();
    byOrder[oid].add(name);
  }

  const pairCount = {};
  for (const items of Object.values(byOrder)) {
    const arr = [...items].sort();
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = `${arr[i]} + ${arr[j]}`;
        pairCount[key] = (pairCount[key] || 0) + 1;
      }
    }
  }

  return Object.entries(pairCount)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([pair, count]) => {
      const [a, b] = pair.split(' + ');
      return { itemA: a, itemB: b, count, label: pair };
    });
}

function buildMenuQuadrant(orderItems) {
  const map = {};
  for (const row of orderItems) {
    const name = row.menu_item?.name;
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

  if (!items.length) return { items: [], medians: { qty: 0, revenue: 0 } };

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
  };
}

async function computeDashboardInsights(supabaseAdmin, restaurantId, startISO, endISO) {
  const heatStart = new Date(endISO);
  heatStart.setDate(heatStart.getDate() - 6);
  const heatStartISO = heatStart.toISOString();

  const [
    ordersRes,
    heatOrdersRes,
    tokensRes,
    auditRes,
  ] = await Promise.all([
    supabaseAdmin.from('orders')
      .select('id, created_at, total_amount, status, source, customer_phone, customer_name')
      .eq('restaurant_id', restaurantId)
      .gte('created_at', startISO).lte('created_at', endISO)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: true }),
    supabaseAdmin.from('orders')
      .select('created_at, total_amount, status')
      .eq('restaurant_id', restaurantId)
      .gte('created_at', heatStartISO).lte('created_at', endISO)
      .neq('status', 'cancelled'),
    supabaseAdmin.from('walk_in_tokens')
      .select('phone, name, arrived_at, status')
      .eq('restaurant_id', restaurantId)
      .gte('arrived_at', startISO).lte('arrived_at', endISO),
    supabaseAdmin.from('audit_logs')
      .select('action, details, created_at')
      .eq('restaurant_id', restaurantId)
      .gte('created_at', startISO).lte('created_at', endISO)
      .or('action.ilike.%stock%,action.ilike.%Stock%'),
  ]);

  const orders = ordersRes.data ?? [];
  const orderIds = orders.map(o => o.id).filter(Boolean);

  let orderItems = [];
  if (orderIds.length) {
    const CHUNK = 150;
    for (let i = 0; i < orderIds.length; i += CHUNK) {
      const chunk = orderIds.slice(i, i + CHUNK);
      const { data: oiData } = await supabaseAdmin.from('order_items')
        .select('order_id, quantity, unit_price, menu_item:menu_item_id(name, price)')
        .in('order_id', chunk);
      if (oiData?.length) orderItems.push(...oiData);
    }
  }

  return {
    revenueHeatmap: buildRevenueHeatmap(heatOrdersRes.data ?? [], endISO),
    serviceSplit: buildServiceSplit(orders),
    repeatTrend: buildRepeatTrend(orders),
    customers: buildCustomerInsights(orders, tokensRes.data ?? []),
    stockOutages: buildStockOutages(auditRes.data),
    comboPatterns: buildComboPatterns(orderItems),
    menuQuadrant: buildMenuQuadrant(orderItems),
  };
}

module.exports = {
  computeDashboardInsights,
  normPhone,
  channelFromSource,
};
