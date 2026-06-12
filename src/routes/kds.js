// src/routes/kds.js
// ============================================================================
// KDS Notify — POST /api/kds/notify
// ============================================================================
// Called by booking_agent.py _notify_kds() after special notes are captured.
//
// This is the AUTHORITATIVE implementation. It replaces:
//   1. The dead server.js version (app.post('/api/kds/notify') was shadowed by pos.js)
//   2. The weak pos.js version (lacked ghost items, receipts, fulfillment groups)
//
// After extracting this file, remove router.post('/kds/notify') from pos.js.
//
// Flow:
//   1. Auth via shared KDS secret
//   2. Resolve table_id from table_number (dine-in)
//   3. Create orders row (so kds_items → order_items → orders FK works)
//   4. For each item: resolve menu_item_id → create order_item + kds_item
//      Ghost menu_item created if item not in catalog (preserves FK integrity)
//   5. Bulk-insert kds_items
//   6. Broadcast ORDER_NEW → KDSScreen.jsx refreshes immediately
//   7. Send receipt URL to customer via WhatsApp
//   8. Create fulfillment groups for multi-counter takeaway
//   9. Audit log
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin }       = require('../config/supabase');
const { broadcastToRestaurant } = require('../websocket');
const { sendWhatsAppMessage }  = require('../helpers/whatsapp');

const { getKdsSecret } = require('../config/internalSecret');

// ── POST /api/kds/notify ──────────────────────────────────────────────────────

router.post('/notify', async (req, res) => {

  // ── Auth (shared secret — same as Python booking agent) ─────────────────────
  const { secret } = req.body;
  if (secret !== getKdsSecret()) {
    console.warn('[kds-notify] Rejected — bad secret');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const {
    restaurant_id,
    customer_name,
    customer_phone,
    token_number,
    table_number,
    service_type,
    items          = [],
    special_notes,
    advance_credit = 0,
  } = req.body;

  if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id required' });
  if (!items.length)  return res.status(400).json({ error: 'items array must not be empty' });

  try {

    // ── Step 1: Resolve table_id ──────────────────────────────────────────────
    let tableId = null;
    if (table_number) {
      const { data: tableRow } = await supabaseAdmin
        .from('tables').select('id')
        .eq('restaurant_id', restaurant_id)
        .eq('table_number', String(table_number))
        .maybeSingle();
      tableId = tableRow?.id ?? null;
    }

    // ── Step 2: Create orders row ─────────────────────────────────────────────
    const orderNumber = token_number
      ? `ORD-${String(token_number).replace(/^T-/, '')}`
      : `ORD-WA-${Date.now()}`;

    const cleanPhone = customer_phone
      ? String(customer_phone).replace(/\D/g, '')
      : null;

    const { data: orderRow, error: orderErr } = await supabaseAdmin
      .from('orders')
      .insert({
        restaurant_id,
        table_id:             tableId,
        order_number:         orderNumber,
        status:               'pending',
        source:               service_type || 'whatsapp_booking',
        customer_phone:       cleanPhone,
        special_instructions: special_notes || null,
      })
      .select('id, order_number')
      .single();

    if (orderErr) {
      console.error('[kds-notify] orders insert failed:', orderErr.message);
      return res.status(500).json({ error: orderErr.message });
    }

    // ── Step 3: Per-item: resolve menu_item_id → order_item → kds_item ────────
    const kdsInserts      = [];
    let   kdsItemsCreated = 0;

    for (const item of items) {
      // 3a: Resolve by retailer_id
      let menuItemId = null;

      if (item.retailer_id && item.retailer_id !== 'manual') {
        const { data: byRetailer } = await supabaseAdmin
          .from('menu_items').select('id')
          .eq('restaurant_id', restaurant_id)
          .eq('retailer_id', item.retailer_id)
          .maybeSingle();
        menuItemId = byRetailer?.id ?? null;
      }

      // 3b: Resolve by name (case-insensitive fallback)
      if (!menuItemId && item.name) {
        const { data: byName } = await supabaseAdmin
          .from('menu_items').select('id')
          .eq('restaurant_id', restaurant_id)
          .ilike('name', item.name.trim())
          .maybeSingle();
        menuItemId = byName?.id ?? null;
      }

      // 3c: Ghost item — satisfies FK, keeps KDS accurate, never shown in menu
      if (!menuItemId) {
        const ghostRetailerId = (item.retailer_id && item.retailer_id !== 'manual')
          ? item.retailer_id
          : `ghost-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        const { data: ghost, error: ghostErr } = await supabaseAdmin
          .from('menu_items')
          .insert({
            restaurant_id,
            retailer_id:  ghostRetailerId,
            name:         item.name || 'Item',
            price:        parseFloat(item.unit_price) || 0,
            is_available: false,
            is_stocked:   false,
            time_slot:    'all',
            category:     'Manual',
          })
          .select('id')
          .single();

        if (ghostErr) {
          console.warn(`[kds-notify] ghost menu_item failed for "${item.name}":`, ghostErr.message);
          continue;
        }
        menuItemId = ghost.id;
      }

      // 3d: order_items row
      const qty       = parseInt(item.qty || item.quantity || 1, 10);
      const unitPrice = parseFloat(item.unit_price || 0);

      const { data: orderItem, error: oiErr } = await supabaseAdmin
        .from('order_items')
        .insert({
          order_id:     orderRow.id,
          menu_item_id: menuItemId,
          quantity:     qty,
          unit_price:   unitPrice,
        })
        .select('id')
        .single();

      if (oiErr) {
        console.warn(`[kds-notify] order_items failed for "${item.name}":`, oiErr.message);
        continue;
      }

      // 3e: Stage kds_item for bulk insert
      kdsInserts.push({
        restaurant_id,
        order_item_id:        orderItem.id,
        status:               'pending',
        priority:             'normal',
        item_name:            item.name     || 'Item',
        token_number:         token_number  || null,
        customer_phone:       cleanPhone,
        service_type:         service_type  || null,
        special_instructions: special_notes || null,
        item_category:        item.category || '',
      });
    }

    // ── Step 4: Bulk-insert kds_items ─────────────────────────────────────────
    if (kdsInserts.length > 0) {
      const { error: kdsErr } = await supabaseAdmin.from('kds_items').insert(kdsInserts);
      if (kdsErr) {
        console.error('[kds-notify] kds_items insert failed:', kdsErr.message);
        return res.status(500).json({ error: kdsErr.message });
      }
      kdsItemsCreated = kdsInserts.length;
    }

    // ── Step 5: Broadcast ORDER_NEW → KDSScreen.jsx ───────────────────────────
    broadcastToRestaurant(restaurant_id, {
      type:           'ORDER_NEW',
      order_id:       orderRow.id,
      order_number:   orderRow.order_number,
      token_number:   token_number   ?? null,
      table_number:   table_number   ?? null,
      customer_name:  customer_name  ?? null,
      customer_phone: cleanPhone,
      service_type:   service_type   ?? null,
      special_notes:  special_notes  ?? null,
      advance_credit: advance_credit || 0,
      item_count:     kdsItemsCreated,
      source:         'whatsapp_booking',
      timestamp:      new Date().toISOString(),
    });

    // ── Step 6: Send receipt URL to customer ──────────────────────────────────
    if (cleanPhone && kdsItemsCreated > 0) {
      const receiptUrl  = `${process.env.API_BASE_URL ?? 'https://api.autom8.works'}/verify/${orderRow.id}`;
      const advanceLine = advance_credit > 0
        ? `\n🎟️ Reservation advance applied: -₹${Number(advance_credit).toFixed(0)}`
        : '';
      sendWhatsAppMessage(
        cleanPhone,
        `🧾 *Your receipt is ready!*\n\nOrder: *${orderRow.order_number}*${advanceLine}\nTap to view your itemised bill:\n${receiptUrl}`,
        restaurant_id
      ).catch(e => console.error('[kds-notify] Receipt send failed (non-fatal):', e.message));
    }

    // ── Step 7: Fulfillment groups (multi-counter takeaway) ───────────────────
    const isTA = service_type === 'takeaway' || service_type === 'whatsapp_booking';
    if (isTA) {
      try {
        const { data: rest } = await supabaseAdmin
          .from('restaurants').select('takeaway_fulfillment_mode').eq('id', restaurant_id).single();

        if (rest?.takeaway_fulfillment_mode === 'multi_counter') {
          const { data: groupResult } = await supabaseAdmin.rpc(
            'create_fulfillment_groups',
            { p_order_id: orderRow.id, p_restaurant_id: restaurant_id }
          );
          console.log(`[kds-notify] Fulfillment groups: ${groupResult?.created ?? 0} created for ${orderRow.order_number}`);
        }
      } catch (fgErr) {
        console.error('[kds-notify] Fulfillment group creation failed (non-fatal):', fgErr.message);
      }
    }

    // ── Step 8: Audit log ─────────────────────────────────────────────────────
    supabaseAdmin.from('audit_logs').insert({
      restaurant_id,
      action:  'KDS items created via booking agent',
      details: { order_id: orderRow.id, order_number: orderRow.order_number, token_number, service_type, kds_items: kdsItemsCreated },
    }).catch(() => {});

    console.log(
      `[kds-notify] ✅ ${kdsItemsCreated} KDS item(s)` +
      ` | order ${orderRow.order_number}` +
      ` | token ${token_number ?? 'N/A'}` +
      ` | table ${table_number ?? 'N/A'}`
    );

    return res.status(201).json({
      success:           true,
      order_id:          orderRow.id,
      order_number:      orderRow.order_number,
      kds_items_created: kdsItemsCreated,
    });

  } catch (err) {
    console.error('[kds-notify] Unexpected error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
