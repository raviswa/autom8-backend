'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { signFormToken } = require('./supplyFormToken');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

function parseTimeToMinutes(t) {
  if (!t) return 0;
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function istNowParts() {
  const fmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric', minute: 'numeric', hour12: false,
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const minutes = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  const weekday = parts.weekday;
  return { minutes, weekday, dateLabel: `${parts.day} ${parts.month}` };
}

function isOrderingOpen(supplier) {
  if (supplier.ordering_always_open) return true;
  const { minutes } = istNowParts();
  const openMin = parseTimeToMinutes(supplier.ordering_open_time || '18:00');
  const closeMin = parseTimeToMinutes(supplier.ordering_cutoff || '22:00');
  return minutes >= openMin && minutes <= closeMin;
}

function formTokenExpiryUnix(supplier) {
  const { minutes } = istNowParts();
  const closeMin = parseTimeToMinutes(supplier.ordering_cutoff || '22:00');
  const nowSec = Math.floor(Date.now() / 1000);
  const minsLeft = Math.max(30, closeMin - minutes);
  return nowSec + minsLeft * 60;
}

function getNextDeliveryDate(deliveryDays) {
  const days = Array.isArray(deliveryDays) && deliveryDays.length ? deliveryDays : ['Monday'];
  const todayIdx = new Date().getDay();
  for (let offset = 1; offset <= 14; offset++) {
    const idx = (todayIdx + offset) % 7;
    if (days.includes(DAY_NAMES[idx])) {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

function formatDeliveryLabel(isoDate) {
  if (!isoDate) return 'Next scheduled delivery';
  const d = new Date(`${isoDate}T12:00:00`);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const day = d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  return isTomorrow ? `Tomorrow, ${day}` : day;
}

async function getOutstandingBalance(clientId) {
  const { data } = await supabaseAdmin
    .from('supply_credit_ledger')
    .select('balance_after')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return Number(data?.balance_after ?? 0);
}

function buildFormUrl(clientId, supplierId, supplier) {
  const base = (process.env.SUPPLY_ORDER_FORM_URL || process.env.FRONTEND_URL || 'https://app.autom8.works').replace(/\/$/, '');
  const exp = formTokenExpiryUnix(supplier);
  const token = signFormToken(clientId, supplierId, exp);
  return `${base}/supply/order?t=${token}`;
}

async function getLastOrder(clientId) {
  const { data } = await supabaseAdmin
    .from('supply_orders')
    .select('id, order_number, total_amount, created_at, delivery_date, status')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function getPendingOrders(clientId) {
  const { data } = await supabaseAdmin
    .from('supply_orders')
    .select('id, order_number, total_amount, created_at, delivery_date, status')
    .eq('client_id', clientId)
    .in('status', ['confirmed', 'out_for_delivery', 'partial'])
    .order('created_at', { ascending: false });
  return data ?? [];
}

async function getLedger(clientId, limit = 5) {
  const { data } = await supabaseAdmin
    .from('supply_credit_ledger')
    .select('entry_date, type, amount, balance_after, note, order_id')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

async function buildB2bContext(client, supplier) {
  const outstanding = await getOutstandingBalance(client.id);
  const limit = Number(client.credit_limit) || 0;
  const utilisation = limit > 0 ? Math.round((outstanding / limit) * 100) : 0;
  const nextDate = getNextDeliveryDate(client.delivery_days);
  const pending = await getPendingOrders(client.id);
  const lastOrder = await getLastOrder(client.id);

  return {
    supplier_name: supplier.name,
    supplier_phone: supplier.phone,
    supplier_id: supplier.id,
    client_id: client.id,
    client_name: client.name,
    client_slug: client.slug,
    client_gstin: client.gstin || 'Not provided',
    credit_limit: limit,
    outstanding_balance: outstanding,
    credit_available: Math.max(0, limit - outstanding),
    credit_utilisation_pct: utilisation,
    credit_auto_block: client.credit_auto_block !== false,
    credit_terms_days: client.credit_terms_days ?? 30,
    delivery_days: (client.delivery_days || []).join(', '),
    next_delivery_date: formatDeliveryLabel(nextDate),
    next_delivery_iso: nextDate,
    ordering_cutoff: String(supplier.ordering_cutoff || '22:00').slice(0, 5),
    ordering_open_time: String(supplier.ordering_open_time || '18:00').slice(0, 5),
    is_ordering_open: isOrderingOpen(supplier),
    order_form_url: buildFormUrl(client.id, supplier.id, supplier),
    last_order_summary: lastOrder ? `#${lastOrder.order_number} · ₹${lastOrder.total_amount}` : null,
    last_order_date: lastOrder?.created_at ?? null,
    last_order_total: lastOrder?.total_amount ?? null,
    pending_orders: pending,
    is_known_client: true,
    oldest_unpaid_days: 0,
    overdue_amount: 0,
  };
}

async function resolveClientByPhone(phone, supplierId) {
  const normalized = normalizePhone(phone);
  let q = supabaseAdmin
    .from('supply_clients')
    .select('*, supply_suppliers(*)')
    .eq('phone', normalized)
    .eq('is_active', true);
  if (supplierId) q = q.eq('supplier_id', supplierId);
  const { data } = await q.limit(1).maybeSingle();
  if (!data) return null;
  const supplier = data.supply_suppliers;
  delete data.supply_suppliers;
  return { client: data, supplier };
}

async function getSupplierByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const { data } = await supabaseAdmin
    .from('supply_suppliers')
    .select('*')
    .eq('whatsapp_phone_number_id', String(phoneNumberId).trim())
    .eq('is_active', true)
    .maybeSingle();
  return data;
}

async function assertSupplierOwner(userId, supplierId) {
  const { data } = await supabaseAdmin
    .from('supply_suppliers')
    .select('id')
    .eq('id', supplierId)
    .eq('owner_user_id', userId)
    .maybeSingle();
  return !!data;
}

async function generateOrderNumber(supplierId) {
  const { data: rows } = await supabaseAdmin
    .from('supply_orders')
    .select('order_number')
    .eq('supplier_id', supplierId);
  let max = 0;
  for (const row of rows ?? []) {
    const m = String(row.order_number).match(/^SO-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `SO-${String(max + 1).padStart(3, '0')}`;
}

async function appendLedgerDebit({ supplierId, clientId, amount, orderId, note }) {
  const prev = await getOutstandingBalance(clientId);
  const balanceAfter = prev + amount;
  const { data, error } = await supabaseAdmin
    .from('supply_credit_ledger')
    .insert({
      supplier_id: supplierId,
      client_id: clientId,
      type: 'debit',
      amount,
      balance_after: balanceAfter,
      order_id: orderId,
      note: note || 'Order placed',
    })
    .select()
    .single();
  if (error) throw error;
  return { balanceAfter, entry: data };
}

async function checkCreditAlerts(clientId, supplierId, utilisationPct) {
  const thresholds = [
    { pct: 80, type: 'utilisation_80' },
    { pct: 90, type: 'utilisation_90' },
    { pct: 100, type: 'utilisation_100' },
  ];
  for (const t of thresholds) {
    if (utilisationPct < t.pct) continue;
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const { data: existing } = await supabaseAdmin
      .from('supply_credit_alerts_log')
      .select('id')
      .eq('client_id', clientId)
      .eq('alert_type', t.type)
      .gte('fired_at', since.toISOString())
      .limit(1);
    if (!existing?.length) {
      await supabaseAdmin.from('supply_credit_alerts_log').insert({
        client_id: clientId,
        alert_type: t.type,
        threshold_pct: t.pct,
      });
    }
  }
}

module.exports = {
  normalizePhone,
  isOrderingOpen,
  buildFormUrl,
  buildB2bContext,
  resolveClientByPhone,
  getSupplierByPhoneNumberId,
  assertSupplierOwner,
  generateOrderNumber,
  appendLedgerDebit,
  checkCreditAlerts,
  getLedger,
  getOutstandingBalance,
  getNextDeliveryDate,
  verifyFormToken: require('./supplyFormToken').verifyFormToken,
};
