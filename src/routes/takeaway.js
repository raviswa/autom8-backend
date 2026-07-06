// src/routes/takeaway.js
// ============================================================================
// Takeaway QR Scan — Counter Terminal Endpoint
//
// Supports two fulfillment modes (set per restaurant in SettingsPanel):
//
//   single_counter  — One QR scan, one counter, order-level lock.
//                     e.g. cloud kitchens, simple snack shops.
//
//   multi_counter   — Same QR works at multiple counters independently.
//                     Each section (sweets, savouries, kitchen…) marks
//                     its own items as collected. Order completes only
//                     when every section that has items in this order
//                     is fulfilled. Empty sections are never created.
//                     e.g. A2B, Ganga Sweets, Perambur Srinivasa.
//
// Counter terminal calls POST /api/v1/takeaway/scan with:
//   { order_id, staff_id, counter_id, section_id? }
//   — or —
//   { qr_token, staff_id, counter_id, section_id? }
//     qr_token: receipt URL (/r/… or /verify/…), portal token (T-001, #097), or order UUID
//
// section_id only required in multi_counter mode.
// Terminal must be pre-configured with its own section_id.
// ============================================================================

'use strict';

const express      = require('express');
const router       = express.Router();
const { supabaseAdmin }  = require('../config/supabase');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');
const { resolveOrderIdForTakeawayScan } = require('../helpers/takeawayScanResolve');
const { runSingleCounterTakeawayScan } = require('../helpers/takeawaySingleCounterScan');


// ── POST /api/v1/takeaway/scan ────────────────────────────────────────────────

router.post('/scan', authenticateToken, getRestaurantId, async (req, res) => {
  let { order_id, qr_token, staff_id, counter_id, section_id } = req.body;

  if (!order_id && qr_token) {
    const resolved = await resolveOrderIdForTakeawayScan(req.restaurant_id, qr_token);
    if (resolved.error) {
      return res.status(400).json({ error: resolved.error });
    }
    order_id = resolved.order_id;
  }

  if (!order_id) return res.status(400).json({ error: 'order_id or qr_token is required' });
  if (!staff_id)   return res.status(400).json({ error: 'staff_id is required'   });
  if (!counter_id) return res.status(400).json({ error: 'counter_id is required' });

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(order_id))
    return res.status(400).json({ error: 'order_id must be a valid UUID' });

  try {
    const { data: restaurant } = await supabaseAdmin
      .from('tenants')
      .select('takeaway_fulfillment_mode')
      .eq('id', req.restaurant_id)
      .single();

    const mode = restaurant?.takeaway_fulfillment_mode || 'single_counter';

    if (mode === 'multi_counter') {
      return handleMultiCounterScan(req, res, { order_id, staff_id, counter_id, section_id });
    }
    return handleSingleCounterScan(req, res, { order_id, staff_id, counter_id });

  } catch (err) {
    console.error('[takeaway/scan]', err.message);
    return res.status(500).json({ error: 'Scan failed. Please retry.' });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// SINGLE COUNTER MODE
// ─────────────────────────────────────────────────────────────────────────────

async function handleSingleCounterScan(req, res, { order_id, staff_id, counter_id }) {
  const result = await runSingleCounterTakeawayScan(req.restaurant_id, {
    order_id,
    staff_id,
    counter_id,
  });

  const { body } = result;

  if (body.error && !body.code) {
    return res.status(result.status).json(body);
  }

  switch (body.code) {
    case 'COLLECTED':
      return res.status(200).json({
        success: true,
        code:    'COLLECTED',
        mode:    'single_counter',
        display: {
          screen:       'SUCCESS',
          heading:      '✅ Order Collected',
          subheading:   `Order #${body.order.order_number}`,
          items:        body.order.items,
          total:        `₹${Number(body.order.total_amount).toFixed(2)}`,
          collected_at: body.order.collected_at,
          staff_note:   `Staff ${body.order.collected_by} · Counter ${body.order.counter_id}`,
        },
        order: body.order,
      });

    case 'ALREADY_COLLECTED':
      logFraudAttempt(req.restaurant_id, {
        order_id,
        staff_id,
        counter_id,
        alert: body.alert,
      });
      return res.status(409).json({
        success: false,
        code:    'ALREADY_COLLECTED',
        mode:    'single_counter',
        message: body.message,
        display: buildFraudDisplay(body.alert),
        alert:   body.alert,
      });

    case 'LOCK_CONTENTION':
      return res.status(503).json({
        success: false,
        code:    'LOCK_CONTENTION',
        message: body.message,
        retry_after_ms: body.retry_after_ms ?? 600,
        display: body.display,
      });

    default:
      return res.status(result.status).json({
        success: false,
        code:    body.code,
        message: body.message,
        display: body.display ?? {
          screen: 'INVALID',
          heading: '❓ Invalid QR',
          subheading: body.message || 'Invalid scan',
        },
      });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// MULTI COUNTER MODE
// Each section marks its own items independently.
// Counter 1 (Sweets) and Counter 3 (Savouries) scan the same QR — neither
// blocks the other. Fraud alert fires only if the SAME section scans twice.
// Order marked complete only when every section that has items is fulfilled.
// ─────────────────────────────────────────────────────────────────────────────

async function handleMultiCounterScan(req, res, { order_id, staff_id, counter_id, section_id }) {
  if (!section_id) {
    return res.status(400).json({
      error: 'section_id is required in multi-counter mode.',
      hint:  'The terminal must be configured with its section (e.g. "sweets", "kitchen").',
    });
  }

  const { data, error } = await supabaseAdmin.rpc('scan_fulfillment_group', {
    p_order_id:   order_id,
    p_section_id: String(section_id).trim(),
    p_staff_id:   String(staff_id).trim(),
    p_counter_id: String(counter_id).trim(),
  });

  if (error) {
    console.error('[takeaway/multi] RPC error:', error.message);
    return res.status(500).json({ error: 'Scan processing failed. Please retry.' });
  }

  switch (data.code) {

    case 'COLLECTED': {
      const otherSections = (data.other_sections || []).map(s => ({
        name:       s.section_name,
        item_count: s.item_count,
        status:     s.status,
        label:      s.status === 'collected' ? '✅ Collected' : '⏳ Pending',
      }));

      return res.status(200).json({
        success:        true,
        code:           'COLLECTED',
        mode:           'multi_counter',
        order_complete: data.order_complete,
        display: {
          screen:    'SUCCESS',
          heading:   `✅ ${data.group.section_name} — Handed Over`,
          subheading: `${data.group.item_count} item${data.group.item_count !== 1 ? 's' : ''} collected`,
          items:     data.group.items,
          collected_at: data.group.collected_at,
          staff_note: `Staff ${data.group.collected_by} · Counter ${data.group.counter_id}`,
          // Shows the customer where to go next for remaining items
          other_sections: otherSections,
          order_complete_banner: data.order_complete
            ? '🎉 All sections collected — order complete!'
            : null,
        },
        group:          data.group,
        other_sections: otherSections,
      });
    }

    case 'ALREADY_COLLECTED':
      logFraudAttempt(req.restaurant_id, {
        order_id, staff_id, counter_id, section_id, alert: data.alert,
      });
      return res.status(409).json({
        success: false, code: 'ALREADY_COLLECTED', mode: 'multi_counter',
        message: data.message,
        display: buildFraudDisplay(data.alert, data.alert.section_name),
        alert:   data.alert,
      });

    case 'SECTION_NOT_IN_ORDER':
      // Not fraud — customer simply didn't order from this section
      return res.status(200).json({
        success: false,
        code:    'SECTION_NOT_IN_ORDER',
        mode:    'multi_counter',
        message: data.message,
        display: {
          screen:    'NO_ITEMS',
          heading:   '🔍 Nothing for This Counter',
          subheading: 'This customer has no items from this section.',
          hint:      'They may have already collected these items, or didn\'t order from here.',
        },
      });

    case 'LOCK_CONTENTION':
      return res.status(503).json({
        success: false, code: 'LOCK_CONTENTION', message: data.message,
        retry_after_ms: 600,
        display: { screen: 'RETRY', heading: '⚠️ Please Retry', subheading: data.message },
      });

    default:
      return res.status(404).json({
        success: false, code: data.code, message: data.message,
        display: { screen: 'INVALID', heading: '❓ Invalid QR', subheading: data.message },
      });
  }
}


// ── GET /api/v1/takeaway/order/:order_id ─────────────────────────────────────
// Pre-scan preview. In multi_counter mode, pass ?section_id= to filter items.

router.get('/order/:order_id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data: order, error } = await supabaseAdmin
      .from('orders')
      .select(`
        id, order_number, status, total_amount, customer_phone,
        takeaway_status, collected_at, collected_by, collected_counter,
        order_items (
          id, quantity, unit_price,
          menu_item:menu_item_id ( name, category, fulfillment_section )
        )
      `)
      .eq('id', req.params.order_id)
      .eq('restaurant_id', req.restaurant_id)
      .single();

    if (error || !order) return res.status(404).json({ error: 'Order not found' });

    let items = (order.order_items || []).map(oi => ({
      name:               oi.menu_item?.name               ?? 'Item',
      category:           oi.menu_item?.category           ?? '',
      fulfillment_section: oi.menu_item?.fulfillment_section ?? 'main',
      quantity:           oi.quantity,
    }));

    if (req.query.section_id) {
      items = items.filter(i => i.fulfillment_section === req.query.section_id);
    }

    const { data: groups } = await supabaseAdmin
      .from('order_fulfillment_groups')
      .select('section_id, section_name, item_count, status, collected_at, collected_by')
      .eq('order_id', req.params.order_id);

    res.json({
      success:            true,
      order_id:           order.id,
      order_number:       order.order_number,
      total_amount:       order.total_amount,
      customer_phone:     order.customer_phone,
      takeaway_status:    order.takeaway_status,
      items,
      fulfillment_groups: groups || [],
    });

  } catch (err) {
    console.error('[takeaway/order]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFraudDisplay(alert, sectionName = null) {
  return {
    screen:    'FRAUD_ALERT',
    heading:   sectionName ? `🚫 ${sectionName} Already Collected` : '🚫 Already Collected',
    subheading: `Collected ${alert.time_ago} — ${alert.collected_at_human}`,
    details: [
      { label: 'Time',    value: alert.time_ago },
      { label: 'Staff',   value: `Staff #${alert.collected_by}` },
      { label: 'Counter', value: `Counter ${alert.collected_counter}` },
    ],
    action: 'Contact supervisor if customer disputes this.',
  };
}

function logFraudAttempt(restaurantId, details) {
  supabaseAdmin.from('audit_logs').insert({
    restaurant_id: restaurantId,
    action:        'Takeaway double-scan attempt blocked',
    details,
  }).catch(e => console.error('[takeaway] Audit log failed:', e.message));
}

module.exports = router;
