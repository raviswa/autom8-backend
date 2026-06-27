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

const DEFAULT_FORM_BASE_URL = 'https://order.autom8.works';
const SUPPLY_FORM_BASE_URL = process.env.SUPPLY_FORM_BASE_URL || DEFAULT_FORM_BASE_URL;

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

async function runSchedulerJob(jobName, supplierId, month) {
  switch (jobName) {
    case 'monthly_statement':
    case 'monthly_statements':
      return await runMonthlyStatementsJob(supplierId, month || getPreviousMonth());
    case 'overdue_reminder':
    case 'overdue_reminders':
      return await runOverdueReminderJob(supplierId);
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

module.exports = router;
module.exports.runSchedulerJob = runSchedulerJob;  // ← ADD
