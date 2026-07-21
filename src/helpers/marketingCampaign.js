'use strict';

const { supabaseAdmin } = require('../config/supabase');

const WA_API_URL  = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v20.0';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;

const SEGMENT_KEYS = ['all', 'recent', 'lapsed', 'takeaway', 'high_value', 'never_returned'];
const DAY = 86_400_000;

// ─── Customer map ─────────────────────────────────────────────────────────────

async function buildCustomerMap(restaurantId) {
  const [{ data: tokens, error: tokErr }, { data: orders, error: ordErr }] = await Promise.all([
    supabaseAdmin.from('walk_in_tokens')
      .select('phone, name, type, arrived_at')
      .eq('restaurant_id', restaurantId).not('phone', 'is', null),
    supabaseAdmin.from('orders')
      .select('customer_phone, created_at, total_amount, status')
      .eq('restaurant_id', restaurantId).not('customer_phone', 'is', null),
  ]);
  if (tokErr) console.error('[marketing] walk_in_tokens query failed:', tokErr.message);
  if (ordErr) console.error('[marketing] orders query failed:', ordErr.message);

  const map = new Map();
  const touch = (rawPhone, { name, ts, isTakeaway = false, spend = 0, orderCount = 0 }) => {
    const phone = String(rawPhone).replace(/\D/g, '');
    if (phone.length < 10) return;
    const p = map.get(phone) ?? {
      phone, name: 'Customer', firstActivity: null, lastActivity: null,
      visitCount: 0, takeawayCount: 0, totalSpend: 0, orderCount: 0,
    };
    if (name && name !== 'Guest' && name !== 'Customer') p.name = name;
    if (ts) {
      if (!p.firstActivity || ts < p.firstActivity) p.firstActivity = ts;
      if (!p.lastActivity  || ts > p.lastActivity)  p.lastActivity  = ts;
    }
    p.visitCount    += 1;
    p.takeawayCount += isTakeaway ? 1 : 0;
    p.totalSpend    += spend;
    p.orderCount    += orderCount;
    map.set(phone, p);
  };
  for (const t of tokens ?? []) touch(t.phone, { name: t.name, ts: t.arrived_at, isTakeaway: t.type === 'takeaway' });
  for (const o of orders ?? []) {
    touch(o.customer_phone, {
      ts: o.created_at,
      spend: o.status === 'completed' ? (parseFloat(o.total_amount) || 0) : 0,
      orderCount: 1,
    });
  }
  return map;
}

function filterSegment(customerMap, segKey) {
  const now = Date.now(), out = [];
  for (const p of customerMap.values()) {
    const lastMs  = p.lastActivity  ? new Date(p.lastActivity).getTime()  : 0;
    const firstMs = p.firstActivity ? new Date(p.firstActivity).getTime() : 0;
    const lastDays = lastMs ? (now - lastMs) / DAY : Infinity;
    const firstDays = firstMs ? (now - firstMs) / DAY : Infinity;
    switch (segKey) {
      case 'all':            out.push(p); break;
      case 'recent':         if (lastDays <= 7) out.push(p); break;
      case 'lapsed':         if (lastDays >= 14 && lastDays <= 30) out.push(p); break;
      case 'takeaway':       if (p.takeawayCount >= 3) out.push(p); break;
      case 'high_value':     if (p.totalSpend >= 500) out.push(p); break;
      case 'never_returned': if (p.visitCount === 1 && lastDays > 7) out.push(p); break;
    }
    void firstDays;
  }
  return out;
}

/** Customers matching automation trigger (single customer event). */
function matchAutomationTrigger(customer, triggerType) {
  const now = Date.now();
  const lastMs  = customer.lastActivity  ? new Date(customer.lastActivity).getTime()  : 0;
  const firstMs = customer.firstActivity ? new Date(customer.firstActivity).getTime() : 0;
  const lastDays = lastMs ? (now - lastMs) / DAY : Infinity;
  const firstDays = firstMs ? (now - firstMs) / DAY : Infinity;

  switch (triggerType) {
    case 'lapsed_14d':        return lastDays >= 14 && lastDays <= 16;
    case 'loyalty_5th_order': return customer.orderCount >= 5 && lastDays <= 3;
    case 'first_order':       return customer.orderCount === 1 && firstDays <= 3;
    default:                 return false;
  }
}

function computeStats(customerMap) {
  const now = Date.now();
  let newThisWeek = 0, active30d = 0;
  for (const p of customerMap.values()) {
    const firstMs = p.firstActivity ? new Date(p.firstActivity).getTime() : 0;
    const lastMs  = p.lastActivity  ? new Date(p.lastActivity).getTime()  : 0;
    if (firstMs && (now - firstMs) / DAY <= 7)  newThisWeek++;
    if (lastMs  && (now - lastMs)  / DAY <= 30) active30d++;
  }
  return { total: customerMap.size, new_this_week: newThisWeek, active_30d: active30d, opted_out: 0 };
}

function getPreviewSampleName(customerMap) {
  for (const p of customerMap.values()) {
    if (p.name && p.name !== 'Customer' && p.name !== 'Guest') return p.name;
  }
  return 'Ravi';
}

// ─── WhatsApp send ────────────────────────────────────────────────────────────

async function sendWAText(to, body) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.warn('[marketing] WA not configured — skipping send to', to);
    return;
  }
  const r = await fetch(`${WA_API_URL}/${WA_PHONE_ID}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: String(to), type: 'text', text: { body },
    }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e?.error?.message || `WA send failed (${r.status})`);
  }
}

async function sendWATemplate(to, templateName, languageCode = 'en', components = []) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.warn('[marketing] WA not configured — skipping template send to', to);
    return;
  }
  const r = await fetch(`${WA_API_URL}/${WA_PHONE_ID}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: String(to), type: 'template',
      template: { name: templateName, language: { code: languageCode }, components },
    }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e?.error?.message || `WA template send failed (${r.status})`);
  }
}

// ─── ROI attribution ──────────────────────────────────────────────────────────

async function computeCampaignRoi(restaurantId, campaign) {
  const sentAt = campaign.sent_at ? new Date(campaign.sent_at) : null;
  if (!sentAt) return { orders_48h: 0, revenue_48h: 0 };

  const phones = (campaign.recipient_phones || []).map(r => String(r.phone || r).replace(/\D/g, '')).filter(p => p.length >= 10);
  if (phones.length === 0) return { orders_48h: 0, revenue_48h: 0 };

  const windowEnd = new Date(sentAt.getTime() + 48 * 60 * 60 * 1000).toISOString();
  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('customer_phone, total_amount, status, created_at')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'completed')
    .gte('created_at', sentAt.toISOString())
    .lte('created_at', windowEnd);

  const phoneSet = new Set(phones);
  let orders48h = 0, revenue48h = 0;
  const seen = new Set();
  for (const o of orders ?? []) {
    const p = String(o.customer_phone || '').replace(/\D/g, '');
    if (!phoneSet.has(p) || seen.has(p)) continue;
    seen.add(p);
    orders48h++;
    revenue48h += parseFloat(o.total_amount) || 0;
  }
  return { orders_48h: orders48h, revenue_48h: Math.round(revenue48h * 100) / 100 };
}

// ─── Execute broadcast ────────────────────────────────────────────────────────

async function executeBroadcast(campaignId, restaurantId, { name, segment, template_name, custom_message }) {
  try {
    const { isSubscriptionSoftLocked, buildLapsedPayload } = require('./subscriptionAccess');
    const { data: sub } = await supabaseAdmin
      .from('tenant_subscriptions')
      .select('status, trial_ends_at, renews_at')
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (isSubscriptionSoftLocked(sub)) {
      const payload = buildLapsedPayload(sub || {});
      console.warn('[marketing] blocked broadcast — subscription_lapsed', {
        restaurantId,
        campaignId,
        ...payload,
      });
      await supabaseAdmin.from('broadcast_campaigns').update({
        status: 'failed',
      }).eq('id', campaignId);
      return { ok: false, ...payload };
    }
  } catch (gateErr) {
    console.error('[marketing] soft-lock check failed (continuing):', gateErr.message);
  }
  const map        = await buildCustomerMap(restaurantId);
  const recipients = filterSegment(map, segment);
  if (recipients.length === 0) {
    await supabaseAdmin.from('broadcast_campaigns').update({ status: 'failed' }).eq('id', campaignId);
    return { sent: 0, failed: 0 };
  }

  await supabaseAdmin.from('broadcast_campaigns').update({
    status: 'sending', recipient_count: recipients.length,
    recipient_phones: recipients.map(r => ({ phone: r.phone, name: r.name })),
  }).eq('id', campaignId);

  let sent = 0, failed = 0;
  for (const customer of recipients) {
    try {
      if (template_name) {
        await sendWATemplate(customer.phone, template_name, 'en');
      } else {
        const msg = (custom_message || '').replace(/\{\{name\}\}/gi, customer.name || 'Customer');
        await sendWAText(customer.phone, msg);
      }
      sent++;
    } catch (e) {
      console.error(`[broadcast] Failed for ${customer.phone}:`, e.message);
      failed++;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  const sentAt = new Date().toISOString();
  const roiPayload = { sent_count: sent, failed_count: failed, status: failed === recipients.length ? 'failed' : 'completed', sent_at: sentAt };

  const { data: updated } = await supabaseAdmin.from('broadcast_campaigns')
    .update(roiPayload).eq('id', campaignId).select('*').single();

  if (updated) {
    const roi = await computeCampaignRoi(restaurantId, updated);
    await supabaseAdmin.from('broadcast_campaigns').update({
      roi_orders_48h: roi.orders_48h,
      roi_revenue_48h: roi.revenue_48h,
    }).eq('id', campaignId);
  }

  console.log(`[broadcast] "${name}" complete — sent: ${sent}, failed: ${failed}`);
  return { sent, failed, recipient_count: recipients.length };
}

// ─── Scheduled + automation dispatch ─────────────────────────────────────────

async function dispatchScheduledCampaigns() {
  const now = new Date().toISOString();
  const { data: due, error } = await supabaseAdmin
    .from('broadcast_campaigns')
    .select('*')
    .eq('status', 'scheduled')
    .lte('scheduled_at', now)
    .limit(20);
  if (error) {
    if (error.message?.includes('scheduled_at')) return;
    console.error('[marketing-scheduler] scheduled query:', error.message);
    return;
  }
  for (const c of due ?? []) {
    try {
      await executeBroadcast(c.id, c.restaurant_id, {
        name: c.name, segment: c.segment_type,
        template_name: c.template_name, custom_message: c.custom_message,
      });
    } catch (e) {
      console.error(`[marketing-scheduler] campaign ${c.id}:`, e.message);
    }
  }
}

async function runMarketingAutomations() {
  const { data: automations, error } = await supabaseAdmin
    .from('marketing_automations')
    .select('*')
    .eq('is_active', true)
    .limit(50);
  if (error) {
    if (error.message?.includes('marketing_automations')) return;
    console.error('[marketing-scheduler] automations query:', error.message);
    return;
  }

  for (const auto of automations ?? []) {
    try {
      if (auto.last_run_at) {
        const hoursSince = (Date.now() - new Date(auto.last_run_at).getTime()) / (60 * 60 * 1000);
        if (hoursSince < 24) continue;
      }

      const map = await buildCustomerMap(auto.restaurant_id);
      const matches = [...map.values()].filter(c => matchAutomationTrigger(c, auto.trigger_type));
      if (matches.length === 0) continue;

      const { data: campaign, error: campErr } = await supabaseAdmin
        .from('broadcast_campaigns')
        .insert({
          restaurant_id: auto.restaurant_id,
          name: `[Auto] ${auto.name}`,
          segment_type: auto.segment_type,
          template_name: auto.template_name || null,
          custom_message: auto.custom_message || null,
          recipient_count: matches.length,
          sent_count: 0, failed_count: 0,
          status: 'sending',
          created_by: auto.created_by,
        })
        .select().single();
      if (campErr) throw campErr;

      await supabaseAdmin.from('broadcast_campaigns').update({
        recipient_phones: matches.map(r => ({ phone: r.phone, name: r.name })),
      }).eq('id', campaign.id);

      let sent = 0, failed = 0;
      for (const customer of matches) {
        try {
          if (auto.template_name) {
            await sendWATemplate(customer.phone, auto.template_name, 'en');
          } else if (auto.custom_message) {
            const msg = auto.custom_message.replace(/\{\{name\}\}/gi, customer.name || 'Customer');
            await sendWAText(customer.phone, msg);
          }
          sent++;
        } catch (e) {
          failed++;
        }
        await new Promise(r => setTimeout(r, 100));
      }

      const sentAt = new Date().toISOString();
      await supabaseAdmin.from('broadcast_campaigns').update({
        sent_count: sent, failed_count: failed,
        status: failed === matches.length ? 'failed' : 'completed',
        sent_at: sentAt,
      }).eq('id', campaign.id);

      await supabaseAdmin.from('marketing_automations')
        .update({ last_run_at: sentAt, updated_at: sentAt })
        .eq('id', auto.id);

      console.log(`[automation] "${auto.name}" — sent: ${sent}`);
    } catch (e) {
      console.error(`[automation] ${auto.id}:`, e.message);
    }
  }
}

module.exports = {
  SEGMENT_KEYS,
  buildCustomerMap,
  filterSegment,
  computeStats,
  getPreviewSampleName,
  computeCampaignRoi,
  executeBroadcast,
  dispatchScheduledCampaigns,
  runMarketingAutomations,
  sendWAText,
  sendWATemplate,
};
