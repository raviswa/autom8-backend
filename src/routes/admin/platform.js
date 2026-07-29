'use strict';

/**
 * Platform ops for Autom8 Works owner console (/platform).
 * Auth: requirePlatformAdmin (KDS → super_admin, SUPPORT → support_readonly).
 */

const express = require('express');
const router = express.Router();

const { supabaseAdmin } = require('../../config/supabase');
const {
  requirePlatformAdmin,
  requireSuperAdmin,
  requireAction,
} = require('../../helpers/platformAdminAuth');
const { logAdminAction } = require('../../helpers/adminActionLog');
const { listActivationEvents } = require('../../helpers/tenantActivation');
const { createReferral } = require('../../helpers/referrals');
const {
  isSubscriptionSoftLocked,
  getCycleAnchor,
  GRACE_PERIOD_DAYS,
} = require('../../helpers/subscriptionAccess');
const {
  alreadySent,
  markSent,
  sendMissYou,
  clearOutreach,
} = require('../../helpers/churnReminders');

router.use(requirePlatformAdmin);

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function idleDaysFromInterval(interval, lastOrderAt) {
  if (interval != null) {
    if (typeof interval === 'object' && interval.days != null) {
      return Math.floor(Number(interval.days) + (Number(interval.hours || 0) / 24));
    }
    const s = String(interval);
    const m = s.match(/(\d+)\s*days?/i);
    if (m) return parseInt(m[1], 10);
  }
  if (lastOrderAt) {
    return Math.floor((Date.now() - new Date(lastOrderAt).getTime()) / (24 * 60 * 60 * 1000));
  }
  return null;
}

function riskFlags({ idleDays, threshold, isActive, lifetimeOrders }) {
  if (isActive === false) return { at_risk: false, churned: true, status_label: 'suspended' };
  if (!(lifetimeOrders > 0) || idleDays == null) {
    return { at_risk: false, churned: false, status_label: 'activating' };
  }
  if (idleDays >= threshold + 14) {
    return { at_risk: true, churned: true, status_label: 'churned' };
  }
  if (idleDays >= threshold) {
    return { at_risk: true, churned: false, status_label: 'at_risk' };
  }
  return { at_risk: false, churned: false, status_label: 'active' };
}

async function loadIdleThresholdMap() {
  const { data, error } = await supabaseAdmin.from('churn_idle_thresholds').select('lob_type, idle_days');
  if (error) {
    console.warn('[admin] churn_idle_thresholds unavailable:', error.message);
    return { map: {}, defaultDays: 30 };
  }
  const map = Object.fromEntries((data || []).map((r) => [r.lob_type, r.idle_days]));
  return { map, defaultDays: map.default || 30 };
}

async function extendSubscriptionDays(restaurantId, days) {
  const d = Math.round(Number(days));
  if (!Number.isFinite(d) || d === 0) {
    const err = new Error('days must be a non-zero number');
    err.status = 400;
    throw err;
  }
  const { data: sub } = await supabaseAdmin
    .from('tenant_subscriptions')
    .select('id, status, trial_ends_at, renews_at')
    .eq('restaurant_id', restaurantId)
    .maybeSingle();

  const now = Date.now();
  const field = sub?.status === 'trial' || (!sub?.renews_at && sub?.trial_ends_at)
    ? 'trial_ends_at'
    : 'renews_at';
  const currentRaw = sub?.[field] || sub?.trial_ends_at || sub?.renews_at;
  const currentMs = currentRaw ? new Date(currentRaw).getTime() : now;
  const base = Math.max(now, currentMs);
  const next = new Date(base);
  next.setDate(next.getDate() + d);

  const patch = {
    [field]: next.toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (sub?.id) {
    await supabaseAdmin.from('tenant_subscriptions').update(patch).eq('id', sub.id);
  } else {
    await supabaseAdmin.from('tenant_subscriptions').insert({
      restaurant_id: restaurantId,
      status: 'trial',
      trial_ends_at: next.toISOString(),
      billing_cycle: 'monthly',
    });
  }
  return { field, until: next.toISOString(), days: d };
}

function actorMeta(req) {
  return { actorRole: req.adminRole, actorLabel: req.adminLabel };
}

// ── GET /api/admin/tenants ────────────────────────────────────────────────────

router.get('/tenants', async (req, res) => {
  try {
    const page = clampInt(req.query.page, 1, 1, 100000);
    const limit = clampInt(req.query.limit, 25, 1, 100);
    const offset = (page - 1) * limit;
    const q = String(req.query.q || '').trim();
    const lob = String(req.query.lob_type || '').trim();
    const source = String(req.query.referral_source || '').trim();
    const statusFilter = String(req.query.status || '').trim(); // active|at_risk|churned|suspended

    let query = supabaseAdmin
      .from('tenants')
      .select(
        'id, name, display_name, email, contact_email, whatsapp_number, waba_id, lob_type, is_active, created_at, brand_id, referral_source, signup_source_detail, utm_source, utm_campaign, referred_by_restaurant_id',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (q) {
      query = query.or(
        `name.ilike.%${q}%,display_name.ilike.%${q}%,email.ilike.%${q}%,contact_email.ilike.%${q}%,whatsapp_number.ilike.%${q}%`,
      );
    }
    if (lob) query = query.eq('lob_type', lob);
    if (source) query = query.eq('referral_source', source);
    if (statusFilter === 'suspended') query = query.eq('is_active', false);

    let { data: tenants, error, count } = await query;
    if (error && /referral_source|signup_source_detail|utm_/i.test(error.message || '')) {
      // Attribution columns not migrated yet — fall back to core roster fields.
      console.warn('[admin/tenants] attribution columns missing — core select:', error.message);
      let fallback = supabaseAdmin
        .from('tenants')
        .select(
          'id, name, display_name, email, contact_email, whatsapp_number, waba_id, lob_type, is_active, created_at, brand_id',
          { count: 'exact' },
        )
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (q) {
        fallback = fallback.or(
          `name.ilike.%${q}%,display_name.ilike.%${q}%,email.ilike.%${q}%,contact_email.ilike.%${q}%,whatsapp_number.ilike.%${q}%`,
        );
      }
      if (lob) fallback = fallback.eq('lob_type', lob);
      if (statusFilter === 'suspended') fallback = fallback.eq('is_active', false);
      ({ data: tenants, error, count } = await fallback);
    }
    if (error) return res.status(500).json({ error: error.message });

    const rows = tenants || [];
    const ids = rows.map((t) => t.id);
    const { map: threshMap, defaultDays } = await loadIdleThresholdMap();

    let integrations = [];
    let menuCounts = {};
    let subscriptions = [];
    let activityRows = [];

    if (ids.length) {
      const [intRes, menuRes, subRes, actRes] = await Promise.all([
        supabaseAdmin
          .from('tenant_integrations')
          .select('id, restaurant_id, phone_number_id, waba_id, is_active')
          .in('restaurant_id', ids)
          .eq('provider', 'meta')
          .eq('channel', 'whatsapp')
          .eq('is_active', true),
        supabaseAdmin
          .from('menu_items')
          .select('restaurant_id')
          .in('restaurant_id', ids),
        supabaseAdmin
          .from('tenant_subscriptions')
          .select('restaurant_id, status, trial_ends_at, renews_at, final_price, base_price')
          .in('restaurant_id', ids),
        supabaseAdmin
          .from('tenant_activity')
          .select('tenant_id, last_order_at, lifetime_orders, idle_interval')
          .in('tenant_id', ids),
      ]);

      if (subRes.error) {
        console.warn('[admin/tenants] subscriptions query:', subRes.error.message);
      }
      if (actRes.error) {
        console.warn('[admin/tenants] tenant_activity unavailable:', actRes.error.message);
      }

      integrations = intRes.data || [];
      subscriptions = subRes.data || [];
      activityRows = actRes.error ? [] : (actRes.data || []);
      for (const row of menuRes.data || []) {
        menuCounts[row.restaurant_id] = (menuCounts[row.restaurant_id] || 0) + 1;
      }
    }

    const intByRest = Object.fromEntries(integrations.map((i) => [i.restaurant_id, i]));
    const subByRest = Object.fromEntries(subscriptions.map((s) => [s.restaurant_id, s]));
    const actByRest = Object.fromEntries(activityRows.map((a) => [a.tenant_id, a]));

    let items = rows.map((t) => {
      const integ = intByRest[t.id];
      const sub = subByRest[t.id];
      const act = actByRest[t.id] || {};
      const threshold = threshMap[t.lob_type] || defaultDays;
      const idleDays = idleDaysFromInterval(act.idle_interval, act.last_order_at);
      const flags = riskFlags({
        idleDays,
        threshold,
        isActive: t.is_active,
        lifetimeOrders: act.lifetime_orders,
      });
      const softLocked = sub ? isSubscriptionSoftLocked(sub) : false;
      const mrr = Number(sub?.final_price || sub?.base_price || 0) || 0;
      return {
        id: t.id,
        name: t.name,
        display_name: t.display_name,
        email: t.contact_email || t.email || null,
        whatsapp_number: t.whatsapp_number || null,
        waba_id: t.waba_id || integ?.waba_id || null,
        lob_type: t.lob_type || 'restaurant',
        is_active: t.is_active !== false,
        brand_id: t.brand_id || null,
        created_at: t.created_at,
        referral_source: t.referral_source || null,
        signup_source_detail: t.signup_source_detail || null,
        utm_source: t.utm_source || null,
        utm_campaign: t.utm_campaign || null,
        whatsapp_connected: Boolean(integ?.id || integ?.phone_number_id || (t.whatsapp_number && t.waba_id)),
        catalog_item_count: menuCounts[t.id] || 0,
        last_order_at: act.last_order_at || null,
        lifetime_orders: act.lifetime_orders || 0,
        idle_days: idleDays,
        idle_threshold_days: threshold,
        at_risk: flags.at_risk,
        churned: flags.churned,
        status_label: flags.status_label,
        soft_locked: softLocked,
        mrr,
        subscription: sub
          ? {
              status: sub.status || null,
              trial_ends_at: sub.trial_ends_at || null,
              renews_at: sub.renews_at || null,
              paid_features: [],
              final_price: sub.final_price ?? null,
            }
          : null,
      };
    });

    if (statusFilter === 'at_risk') items = items.filter((i) => i.at_risk && !i.churned);
    if (statusFilter === 'churned') items = items.filter((i) => i.churned && i.is_active);
    if (statusFilter === 'active') items = items.filter((i) => i.status_label === 'active');

    res.json({
      success: true,
      page,
      limit,
      total: count ?? items.length,
      items,
      role: req.adminRole,
    });
  } catch (err) {
    console.error('[admin/tenants]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/tenants/:id ────────────────────────────────────────────────

router.get('/tenants/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { data: tenant, error } = await supabaseAdmin
      .from('tenants')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const [integRes, subRes, actRes, menuCountRes, events, outreach, feedback] = await Promise.all([
      supabaseAdmin
        .from('tenant_integrations')
        .select('id, phone_number_id, waba_id, is_active, updated_at')
        .eq('restaurant_id', id)
        .eq('provider', 'meta')
        .eq('channel', 'whatsapp')
        .eq('is_active', true)
        .maybeSingle(),
      supabaseAdmin
        .from('tenant_subscriptions')
        .select('*')
        .eq('restaurant_id', id)
        .maybeSingle(),
      supabaseAdmin
        .from('tenant_activity')
        .select('*')
        .eq('tenant_id', id)
        .maybeSingle(),
      supabaseAdmin
        .from('menu_items')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', id),
      listActivationEvents(id),
      supabaseAdmin
        .from('churn_outreach_sent')
        .select('outreach_type, sent_at')
        .eq('tenant_id', id),
      supabaseAdmin
        .from('churn_feedback')
        .select('id, reason, note, submitted_at')
        .eq('tenant_id', id)
        .order('submitted_at', { ascending: false })
        .limit(20),
    ]);

    const { map: threshMap, defaultDays } = await loadIdleThresholdMap();
    const threshold = threshMap[tenant.lob_type] || defaultDays;
    const act = actRes.data || {};
    const idleDays = idleDaysFromInterval(act.idle_interval, act.last_order_at);
    const flags = riskFlags({
      idleDays,
      threshold,
      isActive: tenant.is_active,
      lifetimeOrders: act.lifetime_orders,
    });
    const sub = subRes.data;
    const integ = integRes.data;

    res.json({
      success: true,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        display_name: tenant.display_name,
        email: tenant.contact_email || tenant.email,
        phone: tenant.phone || tenant.contact_phone,
        whatsapp_number: tenant.whatsapp_number,
        waba_id: tenant.waba_id || integ?.waba_id || null,
        lob_type: tenant.lob_type,
        is_active: tenant.is_active !== false,
        created_at: tenant.created_at,
        fssai_license: tenant.fssai_license || null,
        referral_source: tenant.referral_source || null,
        signup_source_detail: tenant.signup_source_detail || null,
        utm_source: tenant.utm_source || null,
        utm_campaign: tenant.utm_campaign || null,
        referred_by_restaurant_id: tenant.referred_by_restaurant_id || null,
        referrer_waba: tenant.referrer_waba || null,
      },
      whatsapp: {
        connected: Boolean(integ?.id || integ?.phone_number_id),
        phone_number_id: integ?.phone_number_id || null,
        updated_at: integ?.updated_at || null,
      },
      subscription: sub || null,
      soft_locked: sub ? isSubscriptionSoftLocked(sub) : false,
      activity: {
        last_order_at: act.last_order_at || null,
        lifetime_orders: act.lifetime_orders || 0,
        idle_days: idleDays,
        idle_threshold_days: threshold,
        ...flags,
      },
      catalog_item_count: menuCountRes.count || 0,
      activation_events: events,
      churn_outreach: outreach.data || [],
      churn_feedback: feedback.data || [],
      role: req.adminRole,
    });
  } catch (err) {
    console.error('[admin/tenants/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/churn/queue ────────────────────────────────────────────────

router.get('/churn/queue', async (req, res) => {
  try {
    const { map: threshMap, defaultDays } = await loadIdleThresholdMap();
    const { data: activity, error } = await supabaseAdmin
      .from('tenant_activity')
      .select('tenant_id, lob_type, is_active, last_order_at, lifetime_orders, idle_interval');
    if (error) {
      console.warn('[admin/churn/queue] tenant_activity unavailable:', error.message);
      return res.json({
        success: true,
        items: [],
        degraded: true,
        error: 'Run migrations/20260729_super_admin_churn_activation.sql to enable churn queue',
      });
    }

    const candidates = (activity || []).filter((row) => {
      if (row.is_active === false) return false;
      if (!(row.lifetime_orders > 0) || !row.last_order_at) return false;
      const idle = idleDaysFromInterval(row.idle_interval, row.last_order_at);
      const threshold = threshMap[row.lob_type] || defaultDays;
      return idle != null && idle >= threshold;
    });

    const ids = candidates.map((c) => c.tenant_id);
    if (!ids.length) {
      return res.json({ success: true, items: [], reason_counts: {} });
    }

    const [tenantsRes, outreachRes, feedbackRes] = await Promise.all([
      supabaseAdmin
        .from('tenants')
        .select('id, name, display_name, email, contact_email, lob_type, referral_source')
        .in('id', ids),
      supabaseAdmin
        .from('churn_outreach_sent')
        .select('tenant_id, outreach_type, sent_at')
        .in('tenant_id', ids),
      supabaseAdmin
        .from('churn_feedback')
        .select('tenant_id, reason, submitted_at')
        .in('tenant_id', ids),
    ]);

    const tenantById = Object.fromEntries((tenantsRes.data || []).map((t) => [t.id, t]));
    const outreachBy = {};
    for (const o of outreachRes.data || []) {
      if (!outreachBy[o.tenant_id]) outreachBy[o.tenant_id] = [];
      outreachBy[o.tenant_id].push(o);
    }
    const feedbackBy = {};
    for (const f of feedbackRes.data || []) {
      if (!feedbackBy[f.tenant_id]) feedbackBy[f.tenant_id] = [];
      feedbackBy[f.tenant_id].push(f);
    }

    const items = candidates.map((row) => {
      const idle = idleDaysFromInterval(row.idle_interval, row.last_order_at);
      const threshold = threshMap[row.lob_type] || defaultDays;
      const t = tenantById[row.tenant_id] || {};
      return {
        tenant_id: row.tenant_id,
        name: t.display_name || t.name || row.tenant_id,
        email: t.contact_email || t.email || null,
        lob_type: row.lob_type,
        referral_source: t.referral_source || null,
        last_order_at: row.last_order_at,
        lifetime_orders: row.lifetime_orders,
        idle_days: idle,
        idle_threshold_days: threshold,
        outreach: outreachBy[row.tenant_id] || [],
        feedback: feedbackBy[row.tenant_id] || [],
        ...riskFlags({
          idleDays: idle,
          threshold,
          isActive: true,
          lifetimeOrders: row.lifetime_orders,
        }),
      };
    }).sort((a, b) => (b.idle_days || 0) - (a.idle_days || 0));

    res.json({ success: true, items });
  } catch (err) {
    console.error('[admin/churn/queue]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/churn/feedback/summary ─────────────────────────────────────

router.get('/churn/feedback/summary', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('churn_feedback')
      .select('reason');
    if (error) {
      console.warn('[admin/churn/feedback/summary]', error.message);
      return res.json({ success: true, counts: {}, total: 0, degraded: true });
    }
    const counts = {};
    for (const row of data || []) {
      const r = row.reason || 'other';
      counts[r] = (counts[r] || 0) + 1;
    }
    res.json({ success: true, counts, total: (data || []).length });
  } catch (err) {
    console.error('[admin/churn/feedback/summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/billing/at-risk ────────────────────────────────────────────

router.get('/billing/at-risk', async (req, res) => {
  try {
    const { data: subs, error } = await supabaseAdmin
      .from('tenant_subscriptions')
      .select('restaurant_id, status, trial_ends_at, renews_at, final_price, base_price')
      .in('status', ['past_due', 'overdue', 'trial', 'active']);
    if (error) return res.status(500).json({ error: error.message });

    const flagged = (subs || []).filter((s) => {
      if (['past_due', 'overdue'].includes(String(s.status || '').toLowerCase())) return true;
      return isSubscriptionSoftLocked(s);
    });
    const ids = flagged.map((s) => s.restaurant_id).filter(Boolean);
    const { data: tenants } = ids.length
      ? await supabaseAdmin
        .from('tenants')
        .select('id, name, display_name, email, contact_email, lob_type, is_active')
        .in('id', ids)
      : { data: [] };
    const byId = Object.fromEntries((tenants || []).map((t) => [t.id, t]));

    const items = flagged.map((s) => {
      const t = byId[s.restaurant_id] || {};
      return {
        tenant_id: s.restaurant_id,
        name: t.display_name || t.name || s.restaurant_id,
        email: t.contact_email || t.email || null,
        lob_type: t.lob_type || null,
        is_active: t.is_active !== false,
        status: s.status,
        soft_locked: isSubscriptionSoftLocked(s),
        trial_ends_at: s.trial_ends_at,
        renews_at: s.renews_at,
        cycle_anchor: getCycleAnchor(s),
        grace_period_days: GRACE_PERIOD_DAYS,
        mrr: Number(s.final_price || s.base_price || 0) || 0,
      };
    });

    res.json({ success: true, items });
  } catch (err) {
    console.error('[admin/billing/at-risk]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Actions ───────────────────────────────────────────────────────────────────

router.post('/tenants/:id/suspend', requireSuperAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    const { error } = await supabaseAdmin
      .from('tenants')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    await logAdminAction({
      ...actorMeta(req),
      actionType: 'suspend',
      tenantId: id,
      reason,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tenants/:id/reactivate', requireSuperAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const reason = String(req.body?.reason || '').trim() || 'reactivated';
    const { error } = await supabaseAdmin
      .from('tenants')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    await logAdminAction({
      ...actorMeta(req),
      actionType: 'reactivate',
      tenantId: id,
      reason,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tenants/:id/extend-trial', requireSuperAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const days = Number(req.body?.days);
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    const result = await extendSubscriptionDays(id, days);
    await logAdminAction({
      ...actorMeta(req),
      actionType: 'extend_trial',
      tenantId: id,
      reason,
      meta: result,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/tenants/:id/referral-credit', requireSuperAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const days = Number(req.body?.days) || 30;
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    const result = await extendSubscriptionDays(id, Math.abs(days));
    await logAdminAction({
      ...actorMeta(req),
      actionType: 'referral_credit',
      tenantId: id,
      reason,
      meta: { ...result, via: 'manual_admin' },
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/tenants/:id/referral-reverse', requireSuperAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const days = Math.abs(Number(req.body?.days) || 30);
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    const result = await extendSubscriptionDays(id, -days);
    await logAdminAction({
      ...actorMeta(req),
      actionType: 'referral_reverse',
      tenantId: id,
      reason,
      meta: result,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/tenants/:id/fssai-override', requireSuperAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const license = String(req.body?.fssai_license || '').trim();
    const reason = String(req.body?.reason || '').trim();
    if (!license) return res.status(400).json({ error: 'fssai_license is required' });
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    const { error } = await supabaseAdmin
      .from('tenants')
      .update({ fssai_license: license, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    await logAdminAction({
      ...actorMeta(req),
      actionType: 'fssai_override',
      tenantId: id,
      reason,
      meta: { fssai_license: license },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tenants/:id/force-wa-refresh', requireSuperAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const reason = String(req.body?.reason || '').trim() || 'force_wa_refresh';
    const { error } = await supabaseAdmin
      .from('tenants')
      .update({
        whatsapp_needs_existing_pin: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    await logAdminAction({
      ...actorMeta(req),
      actionType: 'force_wa_refresh',
      tenantId: id,
      reason,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tenants/:id/churn/miss-you', requireSuperAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const reason = String(req.body?.reason || '').trim() || 'manual_miss_you';
    const outreachType = req.body?.final ? 'miss_you_final' : 'miss_you';
    if (await alreadySent(id, outreachType)) {
      return res.status(409).json({ error: `${outreachType} already sent` });
    }
    const { data: tenant } = await supabaseAdmin
      .from('tenants')
      .select('id, name, display_name, email, contact_email, lob_type')
      .eq('id', id)
      .maybeSingle();
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const result = await sendMissYou(tenant, outreachType);
    if (!result.sent) {
      return res.status(503).json({ error: 'Email not sent', reason: result.reason || null });
    }
    await markSent(id, outreachType);
    await logAdminAction({
      ...actorMeta(req),
      actionType: 'trigger_miss_you',
      tenantId: id,
      reason,
      meta: { outreach_type: outreachType },
    });
    res.json({ success: true, outreach_type: outreachType });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tenants/:id/churn/cancel', requireSuperAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const reason = String(req.body?.reason || '').trim() || 'cancel_churn_sequence';
    await clearOutreach(id);
    await logAdminAction({
      ...actorMeta(req),
      actionType: 'cancel_churn_sequence',
      tenantId: id,
      reason,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tenants/:id/impersonate', requireAction('impersonate'), async (req, res) => {
  try {
    const id = req.params.id;
    const reason = String(req.body?.reason || '').trim() || 'support_impersonate';
    const { data: owner } = await supabaseAdmin
      .from('employees')
      .select('id, email, role, is_active')
      .eq('restaurant_id', id)
      .eq('role', 'owner')
      .eq('is_active', true)
      .maybeSingle();
    if (!owner?.email) {
      return res.status(404).json({ error: 'No active owner found for tenant' });
    }

    const frontend = (process.env.FRONTEND_URL || 'https://app.autom8.works').replace(/\/$/, '');
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: owner.email,
      options: {
        redirectTo: `${frontend}/dashboard`,
      },
    });
    if (error) return res.status(500).json({ error: error.message });

    const actionLink = data?.properties?.action_link || data?.action_link || null;
    const expiresInSec = 60 * 60; // documented window; link TTL is controlled by Supabase

    await logAdminAction({
      ...actorMeta(req),
      actionType: 'impersonate',
      tenantId: id,
      reason,
      meta: { owner_email: owner.email, expires_in_sec: expiresInSec },
    });

    res.json({
      success: true,
      login_url: actionLink,
      owner_email: owner.email,
      expires_in_sec: expiresInSec,
      note: 'Time-boxed magic link for the outlet owner. Do not share outside support.',
    });
  } catch (err) {
    console.error('[admin/impersonate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manual referral create still available via /api/admin/referrals — expose convenience wrap
router.post('/tenants/:id/create-referral', requireSuperAdmin, async (req, res) => {
  try {
    const referrerId = req.params.id;
    const referredId = req.body?.referred_id;
    const days = Number(req.body?.bonus_days) || 30;
    const reason = String(req.body?.reason || '').trim() || 'admin_referral';
    if (!referredId) return res.status(400).json({ error: 'referred_id is required' });
    const created = await createReferral({
      referrerRestaurantId: referrerId,
      referredType: 'tenant',
      referredId,
      createdBy: req.adminLabel || 'admin',
      bonusDays: days,
      creditImmediately: true,
    });
    await logAdminAction({
      ...actorMeta(req),
      actionType: 'create_referral',
      tenantId: referrerId,
      reason,
      meta: { referred_id: referredId, bonus_days: days },
    });
    res.json({ success: true, ...created });
  } catch (err) {
    res.status(err.code === 'duplicate_referral' ? 409 : 500).json({ error: err.message });
  }
});

// ── GET /api/admin/registration-failures ──────────────────────────────────────

router.get('/registration-failures', async (req, res) => {
  try {
    const page = clampInt(req.query.page, 1, 1, 100000);
    const limit = clampInt(req.query.limit, 25, 1, 100);
    const offset = (page - 1) * limit;
    const email = String(req.query.email || '').trim().toLowerCase();

    let query = supabaseAdmin
      .from('registration_failures')
      .select(
        'id, email, slug, restaurant_id, auth_user_id, failed_step, error_message, meta, created_at',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (email) {
      query = query.ilike('email', `%${email}%`);
    }

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({
      success: true,
      page,
      limit,
      total: count ?? (data || []).length,
      items: data || [],
    });
  } catch (err) {
    console.error('[admin/registration-failures]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
