// src/routes/supply/notify.js
// ============================================================================
// MODULE 12 — Notification Engine
//
// Sends WhatsApp messages to supply clients using the supplier's own
// WABA credentials stored in suppliers.waba_phone_number_id.
//
// Exported helper (used by M10 + M13):
//   notifyClient(supplierId, clientPhone, templateName, params)
//
// Internal routes (supplier dashboard):
//   POST /api/supply/notify/send        — ad-hoc send (debug / manual)
//   GET  /api/supply/notify/log         — recent notification log
//
// Templates supported:
//   supply_order_confirmed       — {order_number, delivery_date, total_amount}
//   supply_order_link            — {client_name, order_form_url}
//   supply_new_order_alert       — {client_name, order_number, total_amount}
//   supply_payment_claim_alert   — {client_name, claimed_amount, method, reference}
//   supply_out_for_delivery      — {order_number, delivery_date}
//   supply_delivered             — {order_number}
//   supply_delivery_done_invoice — {order_number, invoice_number, grand_total, pdf_url}
//   supply_payment_confirmed     — {amount, method, balance_after}
//   supply_payment_rejected      — {amount, reason}
//   supply_monthly_statement     — {period, closing_balance, pdf_url}
//   supply_credit_alert          — {outstanding, credit_limit, pct}   (80/90/100%)
//   supply_overdue_reminder      — {outstanding, days_overdue}
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const { supplyAuthMiddleware: auth } = require('../../middleware/supplyAuth');

const META_API = 'https://graph.facebook.com/v19.0';

// ── Template definitions ──────────────────────────────────────────────────────
// Each entry maps to a Meta-approved WhatsApp template name + component builder.
// Template names must match exactly what was submitted in Meta Business Manager.

const TEMPLATES = {
  supply_order_confirmed: {
    name: 'supply_order_confirmed',
    language: 'en',
    components: ({ order_number, delivery_date, total_amount }) => [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: order_number },
          { type: 'text', text: delivery_date },
          { type: 'text', text: `₹${parseFloat(total_amount || 0).toFixed(0)}` },
        ],
      },
    ],
  },

  supply_new_order_alert: {
    name: 'supply_new_order_alert',
    language: 'en',
    components: ({ client_name, order_number, total_amount }) => [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: client_name || 'Client' },
          { type: 'text', text: order_number },
          { type: 'text', text: `₹${parseFloat(total_amount || 0).toFixed(0)}` },
        ],
      },
    ],
  },

  supply_order_link: {
    name: 'supply_order_link',
    language: 'en',
    components: ({ client_name, order_form_url }) => [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: client_name || 'Client' },
        ],
      },
      ...(order_form_url ? [{
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: order_form_url }],
      }] : []),
    ],
  },

  supply_payment_claim_alert: {
    name: 'supply_payment_claim_alert',
    language: 'en',
    components: ({ client_name, claimed_amount, method, reference }) => [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: client_name || 'Client' },
          { type: 'text', text: `₹${parseFloat(claimed_amount || 0).toFixed(0)}` },
          { type: 'text', text: method || reference || 'manual' },
        ],
      },
    ],
  },

  supply_out_for_delivery: {
    name: 'supply_out_for_delivery',
    language: 'en',
    components: ({ order_number, delivery_date }) => [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: order_number },
          { type: 'text', text: delivery_date },
        ],
      },
    ],
  },

  supply_delivered: {
    name: 'supply_delivered',
    language: 'en',
    components: ({ order_number }) => [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: order_number },
        ],
      },
    ],
  },

  supply_payment_confirmed: {
    name: 'supply_payment_confirmed',
    language: 'en',
    components: ({ amount, method, balance_after }) => [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: `₹${parseFloat(amount || 0).toFixed(0)}` },
          { type: 'text', text: method || 'manual' },
          { type: 'text', text: `₹${parseFloat(balance_after || 0).toFixed(0)}` },
        ],
      },
    ],
  },

  supply_payment_rejected: {
    name: 'supply_payment_rejected',
    language: 'en',
    components: ({ amount, reason }) => [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: `₹${parseFloat(amount || 0).toFixed(0)}` },
          { type: 'text', text: reason || 'Please contact your supplier' },
        ],
      },
    ],
  },

  supply_monthly_statement: {
    name: 'supply_monthly_statement',
    language: 'en',
    components: ({ period, closing_balance, pdf_url }) => [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: period },
          { type: 'text', text: `₹${parseFloat(closing_balance || 0).toFixed(0)}` },
        ],
      },
      ...(pdf_url ? [{
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: pdf_url }],
      }] : []),
    ],
  },

  supply_delivery_done_invoice: {
    name: 'supply_delivery_done_invoice',
    language: 'en',
    components: ({ order_number, invoice_number, grand_total, pdf_url }) => [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: order_number },
          { type: 'text', text: invoice_number },
          { type: 'text', text: `₹${parseFloat(grand_total || 0).toFixed(0)}` },
        ],
      },
      ...(pdf_url ? [{
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: pdf_url }],
      }] : []),
    ],
  },

  supply_credit_alert: {
    name: 'supply_credit_alert',
    language: 'en',
    components: ({ outstanding, credit_limit, pct }) => [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: `${pct}%` },
          { type: 'text', text: `₹${parseFloat(outstanding || 0).toFixed(0)}` },
          { type: 'text', text: `₹${parseFloat(credit_limit || 0).toFixed(0)}` },
        ],
      },
    ],
  },

  supply_overdue_reminder: {
    name: 'supply_overdue_reminder',
    language: 'en',
    components: ({ outstanding, days_overdue }) => [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: `₹${parseFloat(outstanding || 0).toFixed(0)}` },
          { type: 'text', text: String(days_overdue || 0) },
        ],
      },
    ],
  },
};

// ── Core send function ────────────────────────────────────────────────────────

/**
 * Send a WhatsApp template message to a client phone number.
 *
 * @param {string} supplierId  - supplier UUID (to look up WABA credentials)
 * @param {string} clientPhone - E.164 phone number of client
 * @param {string} templateKey - key from TEMPLATES map above
 * @param {object} params      - template parameter values
 * @param {string} [clientId]  - optional, for logging
 * @returns {{ ok: boolean, wa_message_id?: string, error?: string }}
 */
async function notifyClient(supplierId, clientPhone, templateKey, params = {}, clientId = null) {
  const template = TEMPLATES[templateKey];
  if (!template) {
    console.error(`[notify] Unknown template: ${templateKey}`);
    return { ok: false, error: `Unknown template: ${templateKey}` };
  }

  // Fetch supplier WABA credentials
  const { data: supplier, error: supErr } = await supabaseAdmin
    .from('suppliers')
    .select('waba_phone_number_id')
    .eq('id', supplierId)
    .maybeSingle();

  if (supErr || !supplier?.waba_phone_number_id) {
    const msg = 'Supplier WABA credentials not configured';
    await logNotification({ supplierId, clientId, templateKey, clientPhone, status: 'failed', error: msg });
    return { ok: false, error: msg };
  }

  if (!clientPhone || typeof clientPhone !== 'string' || !clientPhone.trim()) {
    const errMsg = 'Client phone number is missing';
    await logNotification({ supplierId, clientId, templateKey, clientPhone, status: 'failed', error: errMsg });
    return { ok: false, error: errMsg };
  }

  // Use Munafe's shared WABA token (per supplier phone_number_id)
  // In production, suppliers may have their own tokens stored separately.
  const wabaToken = process.env.META_WABA_TOKEN;
  if (!wabaToken) {
    return { ok: false, error: 'META_WABA_TOKEN not configured' };
  }

  const phone = clientPhone.startsWith('+') ? clientPhone.slice(1) : clientPhone;

  const body = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name:       template.name,
      language:   { code: template.language },
      components: template.components(params),
    },
  };

  try {
    const res = await fetch(
      `${META_API}/${supplier.waba_phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${wabaToken}`,
        },
        body: JSON.stringify(body),
      }
    );

    const data = await res.json();

    if (!res.ok || data.error) {
      const errMsg = data.error?.message || `HTTP ${res.status}`;
      await logNotification({ supplierId, clientId, templateKey, clientPhone, status: 'failed', error: errMsg, payload: body });
      return { ok: false, error: errMsg };
    }

    const waMessageId = data.messages?.[0]?.id;
    await logNotification({ supplierId, clientId, templateKey, clientPhone, status: 'sent', waMessageId, payload: body });
    return { ok: true, wa_message_id: waMessageId };

  } catch (err) {
    await logNotification({ supplierId, clientId, templateKey, clientPhone, status: 'failed', error: err.message, payload: body });
    return { ok: false, error: err.message };
  }
}

// ── Notification log helper ───────────────────────────────────────────────────

async function logNotification({ supplierId, clientId, templateKey, clientPhone, status, waMessageId, error, payload }) {
  try {
    await supabaseAdmin
      .from('supply_notification_log')
      .insert({
        supplier_id:   supplierId,
        client_id:     clientId || null,
        template_name: templateKey,
        phone:         clientPhone,
        direction:     'outbound',
        status,
        wa_message_id: waMessageId || null,
        error_message: error || null,
        payload:       payload || {},
      });
  } catch (logErr) {
    // Log failures must never crash the caller
    console.error('[notify] Failed to write notification log:', logErr.message);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/supply/notify/send
 * Ad-hoc manual send for testing / support.
 * Body: { client_id, template, params }
 */
router.post('/send', auth, async (req, res) => {
  try {
    const { client_id, template: templateKey, params = {} } = req.body;
    const supplierId = req.supplier_id;

    if (!client_id || !templateKey) {
      return res.status(400).json({ error: 'client_id and template required' });
    }

    const { data: client, error: cliErr } = await supabaseAdmin
      .from('supply_clients')
      .select('id, phone, name')
      .eq('id', client_id)
      .eq('supplier_id', supplierId)
      .maybeSingle();

    if (cliErr || !client) return res.status(404).json({ error: 'Client not found' });

    const result = await notifyClient(supplierId, client.phone, templateKey, params, client.id);
    res.json(result);
  } catch (err) {
    console.error('[notify] send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/supply/notify/log?limit=50&client_id=&status=
 * Recent notification history for this supplier.
 */
router.get('/log', auth, async (req, res) => {
  try {
    const supplierId = req.supplier_id;
    const { limit = 50, client_id, status } = req.query;

    let q = supabaseAdmin
      .from('supply_notification_log')
      .select('id, client_id, template_name, phone, direction, status, wa_message_id, error_message, sent_at, supply_clients(name)')
      .eq('supplier_id', supplierId)
      .order('sent_at', { ascending: false })
      .limit(parseInt(limit));

    if (client_id) q = q.eq('client_id', client_id);
    if (status)    q = q.eq('status', status);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true, log: data });
  } catch (err) {
    console.error('[notify] log error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.notifyClient = notifyClient;   // M10, M13 import this
