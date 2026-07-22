// src/routes/supply/scheduler.js
// ============================================================================
// MODULE 13 — Supply scheduler / manual trigger API
//
// POST /api/supply/scheduler/trigger/:job_name  — manual trigger for supported supply jobs
// GET  /api/supply/scheduler/log                — recent scheduler history
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const { supplyAuthMiddleware: auth } = require('../../middleware/supplyAuth');
const { notifyClient } = require('./notify');
const { generateStatement } = require('./statements');
const { isSubscriptionSoftLocked } = require('../../helpers/subscriptionAccess');
const { createFormToken } = require('./supplyFormToken');

const DEFAULT_FORM_BASE_URL = 'https://order.autom8.works';
const SUPPLY_FORM_BASE_URL = process.env.SUPPLY_FORM_BASE_URL || DEFAULT_FORM_BASE_URL;

function getTodayCutoffDate(supplier) {
  const now = new Date();
  const cutoffHour = Number(supplier?.order_cutoff_hour ?? 20);
  const d = new Date(now);
  d.setHours(cutoffHour, 0, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function getPreviousMonth() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
}

function formatPeriodLabel(month) {
  const [year, mon] = month.split('-').map(Number);
  return new Date(year, mon - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
}

async function writeSchedulerLog({ jobName, startedAt, endedAt, recordsProcessed, errors }) {
  try {
    await supabaseAdmin.from('supply_scheduler_log').insert({
      job_name:          jobName,
      status:            errors.length ? 'partial' : 'ok',
      ran_at:            startedAt,
      error_message:     errors.length ? errors.join(' | ') : null,
      ended_at:         endedAt,
      records_processed: recordsProcessed,
    });
  } catch (err) {
    try {
      await supabaseAdmin.from('supply_scheduler_log').insert({
        job_name:          jobName,
        status:            errors.length ? 'partial' : 'ok',
        ran_at:            startedAt,
        records_processed: recordsProcessed,
        error_message:     errors.length ? errors.join(' | ') : null,
      });
    } catch (fallbackErr) {
      console.warn('[supply-scheduler] Failed to write scheduler log:', fallbackErr.message);
    }
  }
}

async function runMonthlyStatementsJob(supplierId, month) {
  const { data: clients, error: clientsErr } = await supabaseAdmin
    .from('supply_clients')
    .select('id, name, phone')
    .eq('supplier_id', supplierId)
    .eq('is_active', true);

  if (clientsErr) {
    throw new Error(`Failed to fetch clients: ${clientsErr.message}`);
  }

  const processed = [];
  const errors = [];
  const period = formatPeriodLabel(month);

  for (const client of clients || []) {
    try {
      const statement = await generateStatement(supplierId, client.id, month);
      const notifyResult = await notifyClient(supplierId, client.phone, 'supply_monthly_statement', {
        period,
        closing_balance: statement.closing_balance,
        pdf_url: statement.signed_url,
      }, client.id);

      if (!notifyResult.ok) {
        errors.push(`client=${client.id} notify failed: ${notifyResult.error}`);
      } else {
        await supabaseAdmin
          .from('supply_statements')
          .update({ sent_to_client: true, sent_at: new Date().toISOString() })
          .eq('id', statement.id);
      }

      processed.push(client.id);
    } catch (err) {
      errors.push(`client=${client.id} error: ${err.message}`);
    }
  }

  return { processedCount: processed.length, errors };
}

async function runOverdueReminderJob(supplierId) {
  const processed = [];
  const errors = [];
  const today = new Date().toISOString().slice(0, 10);

  const { data: clients, error: clientsErr } = await supabaseAdmin
    .from('supply_clients')
    .select('id, name, phone, credit_terms_days')
    .eq('supplier_id', supplierId)
    .eq('is_active', true);

  if (clientsErr) {
    throw new Error(`Failed to fetch clients: ${clientsErr.message}`);
  }

  for (const client of clients || []) {
    try {
      const { data: latestLedger } = await supabaseAdmin
        .from('supply_credit_ledger')
        .select('balance_after')
        .eq('client_id', client.id)
        .eq('supplier_id', supplierId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const outstanding = latestLedger ? parseFloat(latestLedger.balance_after) : 0;
      if (outstanding <= 0) continue;

      const { data: oldestOrder } = await supabaseAdmin
        .from('supply_orders')
        .select('delivery_date')
        .eq('client_id', client.id)
        .eq('supplier_id', supplierId)
        .in('status', ['delivered', 'partially_delivered'])
        .order('delivery_date', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!oldestOrder) continue;

      const deliveryDate = new Date(oldestOrder.delivery_date);
      const dueDate = new Date(deliveryDate);
      dueDate.setDate(dueDate.getDate() + (client.credit_terms_days || 30));
      const now = new Date();
      if (now <= dueDate) continue;

      const daysOverdue = Math.floor((now - dueDate) / 86400000);

      const { data: existingReminder } = await supabaseAdmin
        .from('supply_notification_log')
        .select('id')
        .eq('supplier_id', supplierId)
        .eq('client_id', client.id)
        .eq('template_name', 'supply_overdue_reminder')
        .gte('sent_at', `${today}T00:00:00Z`)
        .maybeSingle();

      if (existingReminder) continue;

      const notifyResult = await notifyClient(supplierId, client.phone, 'supply_overdue_reminder', {
        outstanding,
        days_overdue: daysOverdue,
      }, client.id);

      if (!notifyResult.ok) {
        errors.push(`client=${client.id} notify failed: ${notifyResult.error}`);
      } else {
        processed.push(client.id);
      }
    } catch (err) {
      errors.push(`client=${client.id} error: ${err.message}`);
    }
  }

  return { processedCount: processed.length, errors };
}

async function runReorderNudgeJob(supplierId) {
  const { data: supplier } = await supabaseAdmin
    .from('suppliers')
    .select('id, subscription_status, subscription_current_period_end, order_cutoff_hour')
    .eq('id', supplierId)
    .maybeSingle();

  if (!supplier || isSubscriptionSoftLocked(supplier)) {
    return { processedCount: 0, errors: ['supplier soft-locked or missing'] };
  }

  const { data: clients, error: clientsErr } = await supabaseAdmin
    .from('supply_clients')
    .select('id, name, phone, is_active, last_reorder_nudge_at')
    .eq('supplier_id', supplierId)
    .eq('is_active', true);
  if (clientsErr) throw new Error(`Failed to fetch clients: ${clientsErr.message}`);

  const processed = [];
  const errors = [];
  const now = Date.now();
  const DAY = 86400000;

  for (const client of clients || []) {
    try {
      if (!client.phone) continue;

      const { data: orders, error: ordErr } = await supabaseAdmin
        .from('supply_orders')
        .select('id, created_at, status')
        .eq('supplier_id', supplierId)
        .eq('client_id', client.id)
        .in('status', ['confirmed', 'out_for_delivery', 'delivered', 'completed'])
        .order('created_at', { ascending: false })
        .limit(12);
      if (ordErr) throw ordErr;

      const dates = (orders || [])
        .map((o) => new Date(o.created_at).getTime())
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => b - a);
      if (dates.length < 2) continue;

      const gaps = [];
      for (let i = 0; i < dates.length - 1; i += 1) {
        gaps.push((dates[i] - dates[i + 1]) / DAY);
      }
      const med = median(gaps);
      if (!med || med < 2) continue;

      const daysSince = (now - dates[0]) / DAY;
      // Grace: nudge when overdue by ~1 day past personal median.
      if (daysSince < med + 0.5) continue;

      if (client.last_reorder_nudge_at) {
        const nudgedAt = new Date(client.last_reorder_nudge_at).getTime();
        // Don't re-nudge until they've ordered again (last order after nudge) or 14d cooldown.
        if (nudgedAt > dates[0] && (now - nudgedAt) < 14 * DAY) continue;
      }

      const validUntil = getTodayCutoffDate(supplier);
      const token = createFormToken(supplierId, client.id, validUntil, false);
      const orderFormUrl = `${SUPPLY_FORM_BASE_URL.replace(/\/$/, '')}/s/${token}`;
      const notifyResult = await notifyClient(
        supplierId,
        client.phone,
        'supply_order_link',
        { client_name: client.name, order_form_url: orderFormUrl },
        client.id,
      );
      if (!notifyResult.ok) {
        errors.push(`client=${client.id} notify failed: ${notifyResult.error}`);
        continue;
      }

      await supabaseAdmin
        .from('supply_clients')
        .update({ last_reorder_nudge_at: new Date().toISOString() })
        .eq('id', client.id)
        .eq('supplier_id', supplierId);

      processed.push(client.id);
    } catch (err) {
      errors.push(`client=${client.id} error: ${err.message}`);
    }
  }

  return { processedCount: processed.length, errors };
}

async function runSchedulerJob(jobName, supplierId, month) {
  switch (jobName) {
    case 'monthly_statement':
    case 'monthly_statements':
      return await runMonthlyStatementsJob(supplierId, month || getPreviousMonth());
    case 'overdue_reminder':
    case 'overdue_reminders':
      return await runOverdueReminderJob(supplierId);
    case 'reorder_nudge':
    case 'reorder_nudges':
      return await runReorderNudgeJob(supplierId);
    default:
      throw new Error(`Unsupported scheduler job: ${jobName}`);
  }
}

router.post('/trigger/:job_name', auth, async (req, res) => {
  try {
    const supplierId = req.supplier_id;
    const jobName = req.params.job_name;
    const month   = req.query.month || getPreviousMonth();

    if (!/^[0-9]{4}-[0-9]{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }

    const startedAt = new Date().toISOString();
    const result = await runSchedulerJob(jobName, supplierId, month);
    const endedAt = new Date().toISOString();

    await writeSchedulerLog({
      jobName,
      startedAt,
      endedAt,
      recordsProcessed: result.processedCount,
      errors: result.errors,
    });

    res.json({ ok: true, job: jobName, month, processed: result.processedCount, errors: result.errors });
  } catch (err) {
    console.error('[supply-scheduler] trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/log', auth, async (req, res) => {
  try {
    const { limit = 50, job_name } = req.query;
    let q = supabaseAdmin
      .from('supply_scheduler_log')
      .select('*')
      .order('ran_at', { ascending: false })
      .limit(Math.min(parseInt(limit, 10) || 50, 100));

    if (job_name) q = q.eq('job_name', job_name);

    const { data, error } = await q;
    if (error) throw error;

    res.json({ ok: true, log: data });
  } catch (err) {
    console.error('[supply-scheduler] log error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = Object.assign(router, {
  runSchedulerJob,
  runCronJobsForAllSuppliers,
  startSupplySchedulerCron,
});

/**
 * Run a named job for every active supplier.
 * Used by in-process cron (no per-supplier JWT needed).
 */
async function runCronJobsForAllSuppliers(jobName, month) {
  const { data: suppliers, error } = await supabaseAdmin
    .from('suppliers')
    .select('id, business_name')
    .eq('is_active', true);

  if (error) throw new Error(`Failed to list suppliers: ${error.message}`);

  const results = [];
  for (const supplier of suppliers || []) {
    try {
      const result = await runSchedulerJob(jobName, supplier.id, month);
      results.push({
        supplier_id: supplier.id,
        ok: true,
        processedCount: result.processedCount,
        errors: result.errors,
      });
      await writeSchedulerLog({
        jobName: `${jobName}:${supplier.id}`,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        recordsProcessed: result.processedCount,
        errors: result.errors,
      });
    } catch (err) {
      results.push({ supplier_id: supplier.id, ok: false, error: err.message });
      await writeSchedulerLog({
        jobName: `${jobName}:${supplier.id}`,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        recordsProcessed: 0,
        errors: [err.message],
      });
    }
  }
  return results;
}

/**
 * In-process IST cron:
 *  - Overdue reminders: every day at 10:00 IST
 *  - Monthly statements: 1st of each month at 09:00 IST
 * Disable with SUPPLY_SCHEDULER_CRON=0
 */
function startSupplySchedulerCron() {
  if (process.env.SUPPLY_SCHEDULER_CRON === '0') {
    console.log('[supply-scheduler] cron disabled (SUPPLY_SCHEDULER_CRON=0)');
    return;
  }

  const lastRun = { overdue: '', monthly: '', reorder: '' };

  const tick = async () => {
    try {
      const now = new Date(
        new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
      );
      const ymd = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ].join('-');
      const hour = now.getHours();
      const day = now.getDate();

      if (hour === 10 && lastRun.overdue !== ymd) {
        lastRun.overdue = ymd;
        console.log('[supply-scheduler] cron overdue_reminders starting');
        const results = await runCronJobsForAllSuppliers('overdue_reminders');
        console.log('[supply-scheduler] cron overdue_reminders done', results.length);

        // SaaS subscription billing reminders (supplier entity) — same job as
        // main server; subscription_reminders_sent dedup prevents double-send.
        try {
          const { runReminderCheck } = require('../../helpers/billingReminders');
          const billing = await runReminderCheck({ entityTypes: ['supplier'] });
          console.log('[supply-scheduler] cron subscription billing reminders', billing);
        } catch (billingErr) {
          console.error('[supply-scheduler] billing reminders failed:', billingErr.message);
        }
      }

      if (hour === 11 && lastRun.reorder !== ymd) {
        lastRun.reorder = ymd;
        console.log('[supply-scheduler] cron reorder_nudges starting');
        const results = await runCronJobsForAllSuppliers('reorder_nudges');
        console.log('[supply-scheduler] cron reorder_nudges done', results.length);
      }

      if (day === 1 && hour === 9 && lastRun.monthly !== ymd) {
        lastRun.monthly = ymd;
        console.log('[supply-scheduler] cron monthly_statements starting');
        const results = await runCronJobsForAllSuppliers(
          'monthly_statements',
          getPreviousMonth()
        );
        console.log('[supply-scheduler] cron monthly_statements done', results.length);
      }
    } catch (err) {
      console.error('[supply-scheduler] cron tick failed:', err.message || err);
    }
  };

  // Check every 15 minutes
  setInterval(tick, 15 * 60 * 1000);
  // First check shortly after boot
  setTimeout(tick, 30 * 1000);
  console.log('[supply-scheduler] in-process IST cron started (overdue 10:00, reorder 11:00, monthly 1st 09:00)');
}
