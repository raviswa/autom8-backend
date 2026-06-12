// src/routes/invoices.js
// ============================================================================
// Invoice generation and accounting sync
//
// POST /api/invoices/generate   — Manual invoice generation (dashboard / POS)
// POST /api/invoices/webhook    — Auto-trigger on payment_status → 'paid'
//
// Helpers: calculateGST, buildInvoicePayload, pushInvoiceToAccounting
// The accounting scheduler (nightly Zoho/Tally push) is in schedulers/index.js
// but imports pushInvoiceToAccounting from here.
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabase, supabaseAdmin }        = require('../config/supabase');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');

const { getKdsSecret } = require('../config/internalSecret');

const GST_RATES = {
  default:          5,   // CGST 2.5% + SGST 2.5%  (restaurant without ITC)
  premium_service: 18,   // AC restaurants / hotels with room tariff > ₹7500
  non_ac:           5,
};

// ── calculateGST ──────────────────────────────────────────────────────────────

function calculateGST(subtotal, ratePercent = 5) {
  const rate      = Number(ratePercent) || 5;
  const halfRate  = rate / 2;
  const cgst      = parseFloat(((subtotal * halfRate) / 100).toFixed(2));
  const sgst      = parseFloat(((subtotal * halfRate) / 100).toFixed(2));
  const totalTax  = parseFloat((cgst + sgst).toFixed(2));
  const grandTotal = parseFloat((subtotal + totalTax).toFixed(2));
  return { cgst, sgst, totalTax, grandTotal };
}

// ── buildInvoicePayload ────────────────────────────────────────────────────────

function buildInvoicePayload(order, restaurant, gstRate = 5) {
  const subtotal       = parseFloat(order.subtotal ?? 0);
  const deliveryCharge = parseFloat(order.delivery_charge ?? 0);
  const { cgst, sgst, grandTotal } = calculateGST(subtotal, gstRate);
  const finalTotal = parseFloat((grandTotal + deliveryCharge).toFixed(2));

  return {
    invoice_meta: {
      brand_id:         restaurant.brand_id   ?? null,
      store_id:         restaurant.id,
      store_name:       restaurant.name        ?? '',
      gstin:            restaurant.gstin       ?? '',
      order_id:         order.id,
      order_number:     order.order_number,
      fulfillment_type: order.service_type     ?? order.source ?? 'dine_in',
      invoice_date:     new Date().toISOString(),
    },
    financial_breakdown: {
      subtotal_base_price:          subtotal,
      cgst_amount:                  cgst,
      cgst_rate_pct:                gstRate / 2,
      sgst_amount:                  sgst,
      sgst_rate_pct:                gstRate / 2,
      total_gst:                    parseFloat((cgst + sgst).toFixed(2)),
      packaging_or_delivery_charge: deliveryCharge,
      grand_total:                  finalTotal,
    },
    line_items: (order.order_items ?? []).map(oi => ({
      name:       oi.menu_item?.name     ?? oi.item_name ?? 'Item',
      category:   oi.menu_item?.category ?? '',
      quantity:   oi.quantity            ?? 1,
      unit_price: parseFloat(oi.unit_price ?? 0),
      line_total: parseFloat(((oi.unit_price ?? 0) * (oi.quantity ?? 1)).toFixed(2)),
    })),
    verification: {
      qr_code_data:           `${process.env.API_BASE_URL ?? 'https://api.autom8.works'}/verify/${order.id}`,
      accounting_sync_status: 'PENDING_DAILY_ROLLUP_ZOHO_TALLY',
    },
  };
}

// ── pushInvoiceToAccounting ───────────────────────────────────────────────────
// Dispatches to Zoho Books. Falls back to a no-op stub when ZOHO_CLIENT_ID
// is not configured so the scheduler runs safely in staging.

async function pushInvoiceToAccounting(invoice) {
  const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
  const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
  const ZOHO_ORG_ID        = process.env.ZOHO_ORG_ID;

  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_ORG_ID) {
    // Staging stub — mark as synced without a real API call
    console.log(`[accounting-push] Stub: would push invoice ${invoice.id} to Zoho Books`);
    return;
  }

  // Step 1: Obtain OAuth access token
  const tokenResp = await fetch(
    `https://accounts.zoho.in/oauth/v2/token` +
    `?client_id=${ZOHO_CLIENT_ID}` +
    `&client_secret=${ZOHO_CLIENT_SECRET}` +
    `&grant_type=client_credentials` +
    `&scope=ZohoBooks.invoices.CREATE`,
    { method: 'POST', signal: AbortSignal.timeout(10_000) }
  );
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error('Zoho token fetch failed: ' + JSON.stringify(tokenData));

  // Step 2: POST the invoice to Zoho Books
  const p   = invoice.payload;
  const fb  = p?.financial_breakdown ?? {};
  const body = {
    customer_name:  p?.invoice_meta?.store_name ?? 'Walk-in Customer',
    invoice_number: p?.invoice_meta?.order_number ?? invoice.order_id,
    date:           (p?.invoice_meta?.invoice_date ?? new Date().toISOString()).split('T')[0],
    line_items:     (p?.line_items ?? []).map(li => ({
      name:            li.name,
      quantity:        li.quantity,
      rate:            li.unit_price,
      tax_name:        'GST',
      tax_percentage:  (fb.cgst_rate_pct ?? 2.5) * 2,
    })),
    sub_total: fb.subtotal_base_price,
    tax_total: fb.total_gst,
    total:     fb.grand_total,
  };

  const invoiceResp = await fetch(
    `https://books.zoho.in/api/v3/invoices?organization_id=${ZOHO_ORG_ID}`,
    {
      method:  'POST',
      headers: { Authorization: `Zoho-oauthtoken ${tokenData.access_token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ JSONString: JSON.stringify(body) }),
      signal:  AbortSignal.timeout(15_000),
    }
  );
  const result = await invoiceResp.json();
  if (result.code !== 0) throw new Error(`Zoho Books error: ${result.message}`);
  console.log(`[accounting-push] ✅ Zoho invoice created: ${result.invoice?.invoice_id}`);
}

// ── POST /api/invoices/generate ───────────────────────────────────────────────

router.post('/generate', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const { order_id, gst_rate } = req.body;
    if (!order_id) return res.status(400).json({ error: 'order_id required' });

    const { data: order, error: orderErr } = await supabaseAdmin
      .from('orders')
      .select('*, order_items(quantity, unit_price, menu_item:menu_item_id(name, category))')
      .eq('id', order_id).eq('restaurant_id', req.restaurant_id).single();

    if (orderErr || !order) return res.status(404).json({ error: 'Order not found' });

    const { data: restaurant } = await supabaseAdmin
      .from('restaurants').select('id, name, gstin, brand_id').eq('id', req.restaurant_id).single();

    const gstRate = gst_rate ?? GST_RATES.default;
    const payload = buildInvoicePayload(order, restaurant ?? {}, gstRate);

    const { data: invoice, error: invErr } = await supabaseAdmin
      .from('invoices')
      .upsert({
        restaurant_id:          req.restaurant_id,
        order_id,
        payload,
        gst_rate:               gstRate,
        grand_total:            payload.financial_breakdown.grand_total,
        accounting_sync_status: 'PENDING_DAILY_ROLLUP_ZOHO_TALLY',
        generated_at:           new Date().toISOString(),
      }, { onConflict: 'order_id', ignoreDuplicates: false })
      .select().single();

    if (invErr) throw invErr;

    res.json({ success: true, invoice_id: invoice.id, payload });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/invoices/webhook — auto-trigger on payment → paid ───────────────

router.post('/webhook', async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const { secret, order_id, payment_status } = req.body;
    if (secret !== getKdsSecret()) { console.warn('[invoice-webhook] Bad secret'); return; }
    if (!['paid', 'completed'].includes(payment_status)) return;
    if (!order_id) return;

    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('*, order_items(quantity, unit_price, menu_item:menu_item_id(name, category))')
      .eq('id', order_id).single();

    if (!order) { console.warn(`[invoice-webhook] Order ${order_id} not found`); return; }

    const { data: restaurant } = await supabaseAdmin
      .from('restaurants').select('id, name, gstin, brand_id').eq('id', order.restaurant_id).single();

    const payload = buildInvoicePayload(order, restaurant ?? {}, GST_RATES.default);

    await supabaseAdmin.from('invoices').upsert({
      restaurant_id:          order.restaurant_id,
      order_id,
      payload,
      gst_rate:               GST_RATES.default,
      grand_total:            payload.financial_breakdown.grand_total,
      accounting_sync_status: 'PENDING_DAILY_ROLLUP_ZOHO_TALLY',
      generated_at:           new Date().toISOString(),
    }, { onConflict: 'order_id', ignoreDuplicates: false });

    console.log(`[invoice-webhook] ✅ Invoice generated for order ${order_id}`);
  } catch (err) {
    console.error('[invoice-webhook] Error:', err.message);
  }
});

module.exports = router;
module.exports.buildInvoicePayload     = buildInvoicePayload;
module.exports.calculateGST            = calculateGST;
module.exports.pushInvoiceToAccounting = pushInvoiceToAccounting;
module.exports.GST_RATES               = GST_RATES;
