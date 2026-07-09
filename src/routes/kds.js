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
const { printKotEscPos, buildKotLines } = require('../helpers/kotEscPos');

const { isValidKdsSecret, extractInternalSecret } = require('../config/internalSecret');

// ── POST /api/kds/notify ──────────────────────────────────────────────────────

router.post('/notify', async (req, res) => {

  // ── Auth (Bearer / x-internal-secret / body.secret — same as portal sync) ─
  if (!isValidKdsSecret(extractInternalSecret(req))) {
    const got = extractInternalSecret(req);
    console.warn(
      `[kds-notify] Rejected — bad secret (present=${!!got}, len=${got ? String(got).length : 0})`
    );
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
    booking_id,
    create_kot = false,
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
    // Each checkout round gets its own order_number so dine-in reorders (same token,
    // new items) always produce a fresh KOT. booking_id makes webhook retries idempotent.
    const tokenSuffix = token_number
      ? String(token_number).replace(/^T-/i, '')
      : null;

    const cleanPhone = customer_phone
      ? String(customer_phone).replace(/\D/g, '')
      : null;

    let orderNumber;
    if (booking_id) {
      const bidShort = String(booking_id).replace(/-/g, '').slice(0, 8);
      orderNumber = tokenSuffix
        ? `ORD-${tokenSuffix}-${bidShort}`
        : `ORD-B-${bidShort}`;
    } else if (tokenSuffix) {
      orderNumber = `ORD-${tokenSuffix}`;
    } else {
      orderNumber = `ORD-WA-${Date.now()}`;
    }

    const lineAlreadyOnOrder = (item, existingLines) => {
      const lines = existingLines ?? [];
      const rid = item.retailer_id;
      if (rid && rid !== 'manual') {
        return lines.some((l) => l.menu_item?.retailer_id === rid);
      }
      const name = (item.name || '').trim().toLowerCase();
      if (!name) return false;
      return lines.some(
        (l) => (l.menu_item?.name || '').trim().toLowerCase() === name,
      );
    };

    let { data: existingOrder } = await supabaseAdmin
      .from('orders')
      .select('id, order_number')
      .eq('restaurant_id', restaurant_id)
      .eq('order_number', orderNumber)
      .maybeSingle();

    // Legacy path (no booking_id): if token order exists but cart has NEW items, open a new round.
    if (!booking_id && tokenSuffix && existingOrder?.id) {
      const { data: previewLines } = await supabaseAdmin
        .from('order_items')
        .select('id, menu_item:menu_item_id(retailer_id, name)')
        .eq('order_id', existingOrder.id);
      const preview = previewLines ?? [];
      const hasNewItems = items.some((item) => !lineAlreadyOnOrder(item, preview));
      if (hasNewItems) {
        const { count: roundCount } = await supabaseAdmin
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('restaurant_id', restaurant_id)
          .like('order_number', `ORD-${tokenSuffix}%`);
        const round = (roundCount ?? 1) + 1;
        orderNumber = `ORD-${tokenSuffix}-R${round}`;
        existingOrder = null;
        console.log(
          `[kds-notify] 🔁 reorder round ${orderNumber} for token ${token_number} (${items.length} item(s))`
        );
      }
    }

    if (!existingOrder) {
      const { data: byRound } = await supabaseAdmin
        .from('orders')
        .select('id, order_number')
        .eq('restaurant_id', restaurant_id)
        .eq('order_number', orderNumber)
        .maybeSingle();
      existingOrder = byRound;
    }

    // ── Dedup / repair: idempotent retry for the SAME order_number only ───────
    let orderRow = existingOrder;
    let existingOrderLines = [];

    if (existingOrder?.id) {
      const { data: existingOrderItems } = await supabaseAdmin
        .from('order_items')
        .select('id, menu_item:menu_item_id(retailer_id, name)')
        .eq('order_id', existingOrder.id);
      existingOrderLines = existingOrderItems ?? [];
      const oiIds = existingOrderLines.map((r) => r.id);
      let existingKdsCount = 0;
      if (oiIds.length) {
        const { count } = await supabaseAdmin
          .from('kds_items')
          .select('id', { count: 'exact', head: true })
          .in('order_item_id', oiIds);
        existingKdsCount = count ?? 0;
      }

      const newItemsNeeded = items.filter((item) => !lineAlreadyOnOrder(item, existingOrderLines));

      // Repair: order + order_items exist but KDS lines were never created (failed prior notify).
      if (existingOrderLines.length > 0 && existingKdsCount === 0) {
        const oiIds = existingOrderLines.map((r) => r.id);
        const { data: oiDetail } = await supabaseAdmin
          .from('order_items')
          .select('id, quantity, menu_item:menu_item_id(name)')
          .in('id', oiIds);
        const repairInserts = (oiDetail ?? []).map((oi) => ({
          restaurant_id,
          order_item_id:        oi.id,
          status:               'pending',
          priority:             'normal',
          item_name:            oi.menu_item?.name || 'Item',
          token_number:         token_number  || null,
          customer_phone:       cleanPhone,
          service_type:         service_type  || null,
          special_instructions: special_notes || null,
        }));
        if (repairInserts.length > 0) {
          const { error: repairErr } = await supabaseAdmin.from('kds_items').insert(repairInserts);
          if (!repairErr) {
            console.log(
              `[kds-notify] 🔧 repaired ${repairInserts.length} KDS line(s) for ${orderNumber}`
            );
            broadcastToRestaurant(restaurant_id, {
              type:           'ORDER_NEW',
              order_id:       existingOrder.id,
              order_number:   existingOrder.order_number,
              token_number:   token_number ?? null,
              table_number:   table_number ?? null,
              customer_name:  customer_name ?? null,
              customer_phone: cleanPhone,
              service_type:   service_type ?? null,
              item_count:     repairInserts.length,
              source:         'whatsapp_booking',
              repaired:       true,
              timestamp:      new Date().toISOString(),
            });
            return res.status(201).json({
              success:           true,
              order_id:          existingOrder.id,
              order_number:      existingOrder.order_number,
              kds_items_created: repairInserts.length,
              kds_items_added:   repairInserts.length,
              repaired:          true,
            });
          }
          console.warn(`[kds-notify] KDS repair failed for ${orderNumber}:`, repairErr.message);
        }
      }

      if (newItemsNeeded.length === 0 && existingKdsCount > 0) {
        console.log(
          `[kds-notify] ♻️ deduped ${orderNumber} — all ${items.length} item(s) already on KDS`
        );
        broadcastToRestaurant(restaurant_id, {
          type:             'ORDER_NEW',
          order_id:         existingOrder.id,
          order_number:     existingOrder.order_number,
          token_number:     token_number   ?? null,
          table_number:     table_number   ?? null,
          customer_name:    customer_name  ?? null,
          customer_phone:   cleanPhone,
          service_type:     service_type   ?? null,
          special_notes:    special_notes  ?? null,
          advance_credit:   advance_credit || 0,
          item_count:       existingKdsCount,
          source:           'whatsapp_booking',
          deduplicated:     true,
          timestamp:        new Date().toISOString(),
        });
        return res.json({
          success:           true,
          order_id:          existingOrder.id,
          order_number:      existingOrder.order_number,
          kds_items_created: existingKdsCount,
          kds_items_added:   0,
          deduplicated:      true,
        });
      }
      if (existingKdsCount > 0 && newItemsNeeded.length > 0) {
        console.warn(
          `[kds-notify] ⚠️ partial ${orderNumber} — adding ${newItemsNeeded.length} missing line(s)`
        );
      }
    }

    const lineOnThisOrder = (item) => lineAlreadyOnOrder(item, existingOrderLines);

    if (!orderRow) {
      const { data: inserted, error: orderErr } = await supabaseAdmin
        .from('orders')
        .insert({
          restaurant_id,
          table_id:       tableId,
          order_number:   orderNumber,
          status:         'pending',
          source:         service_type || 'whatsapp_booking',
          customer_phone: cleanPhone,
          notes:          special_notes || null,
          total_amount:    total_amount,
        })
        .select('id, order_number')
        .single();

      if (orderErr) {
        console.error('[kds-notify] orders insert failed:', orderErr.message);
        return res.status(500).json({ error: orderErr.message });
      }
      orderRow = inserted;
    } else if (special_notes) {
      await supabaseAdmin.from('orders')
        .update({ notes: special_notes })
        .eq('id', orderRow.id)
        .eq('restaurant_id', restaurant_id);
    }

    // ── Step 3: Per-item: resolve menu_item_id → order_item → kds_item ────────
    const kdsInserts      = [];
    let   kdsItemsCreated = 0;

    for (const item of items) {
      if (lineOnThisOrder(item)) {
        continue;
      }
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

      const oiRow = {
        order_id:     orderRow.id,
        menu_item_id: menuItemId,
        quantity:     qty,
        unit_price:   unitPrice,
      };
      if (booking_id) oiRow.booking_id = booking_id;

      const { data: orderItem, error: oiErr } = await supabaseAdmin
        .from('order_items')
        .insert(oiRow)
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

    // ── Step 3.5: Recompute + persist order total ─────────────────────────────
    // Sums across ALL order_items on this order (not just the items in this
    // call), so reorder rounds (ORD-xxx-R2 etc.) always reflect the true
    // cumulative total rather than only the latest round's items.
    try {
      const { data: allItemRows, error: totalsErr } = await supabaseAdmin
        .from('order_items')
        .select('quantity, unit_price')
        .eq('order_id', orderRow.id);

      if (totalsErr) {
        console.warn(`[kds-notify] total_amount recompute failed for ${orderRow.order_number}:`, totalsErr.message);
      } else {
        const orderSubtotal = (allItemRows ?? []).reduce(
          (sum, r) => sum + (Number(r.quantity) || 0) * (Number(r.unit_price) || 0),
          0
        );
        const { error: updateTotalErr } = await supabaseAdmin
          .from('orders')
          .update({ subtotal: orderSubtotal, total_amount: orderSubtotal })
          .eq('id', orderRow.id)
          .eq('restaurant_id', restaurant_id);
        if (updateTotalErr) {
          console.warn(`[kds-notify] total_amount write failed for ${orderRow.order_number}:`, updateTotalErr.message);
        }
      }
    } catch (totalsEx) {
      console.warn(`[kds-notify] total_amount step failed (non-fatal): ${totalsEx.message}`);
    }


    // ── Step 4: Bulk-insert kds_items ─────────────────────────────────────────
    const kdsItemsAdded = kdsInserts.length;
    if (kdsInserts.length > 0) {
      const { error: kdsErr } = await supabaseAdmin.from('kds_items').insert(kdsInserts);
      if (kdsErr) {
        console.error('[kds-notify] kds_items insert failed:', kdsErr.message);
        return res.status(500).json({ error: kdsErr.message });
      }
      kdsItemsCreated = kdsInserts.length;
    }

    // ── KOT ticket (scheduled orders — AC7 payment/KOT coupling) ─────────────
    let kotTicketId = null;
    if (create_kot && orderRow?.id) {
      const ticketNumber = `KOT-${orderRow.order_number.replace(/^ORD-/, '')}`;
      const { data: kotRow, error: kotErr } = await supabaseAdmin
        .from('kot_tickets')
        .insert({
          restaurant_id,
          order_id:      orderRow.id,
          ticket_number: ticketNumber,
          status:        'pending',
          priority:      'normal',
        })
        .select('id')
        .maybeSingle();
      if (kotErr) {
        console.error('[kds-notify] kot_tickets insert failed:', kotErr.message);
        return res.status(500).json({ error: `KOT creation failed: ${kotErr.message}` });
      }
      kotTicketId = kotRow?.id ?? null;
      if (kotTicketId && kdsInserts.length > 0) {
        const { data: oiRows } = await supabaseAdmin
          .from('order_items').select('id').eq('order_id', orderRow.id);
        const oiIds = (oiRows ?? []).map((r) => r.id);
        if (oiIds.length) {
          await supabaseAdmin.from('kds_items')
            .update({ kot_ticket_id: kotTicketId })
            .in('order_item_id', oiIds);
        }
      }
    }

    if (orderRow?.id) {
      const { data: oiRows } = await supabaseAdmin
        .from('order_items').select('id').eq('order_id', orderRow.id);
      const ids = (oiRows ?? []).map((r) => r.id);
      if (ids.length) {
        const { count } = await supabaseAdmin
          .from('kds_items')
          .select('id', { count: 'exact', head: true })
          .in('order_item_id', ids);
        if (count != null) kdsItemsCreated = count;
      }
    }

    // ── Step 5: Broadcast ORDER_NEW → KDSScreen.jsx ───────────────────────────
    let kitchenWorkflow = 'Both_KOT_and_KDS';
    let kotPrinterIp = null;
    let kotPrinterPort = 9100;
    let kotPrinterEnabled = false;
    let restaurantName = '';
    try {
      const { data: restRow, error: restErr } = await supabaseAdmin
        .from('tenants')
        .select('kitchen_workflow, kot_printer_ip, kot_printer_port, kot_printer_enabled, name')
        .eq('id', restaurant_id)
        .single();
      if (!restErr && restRow) {
        kitchenWorkflow = restRow.kitchen_workflow || 'Both_KOT_and_KDS';
        kotPrinterIp = restRow.kot_printer_ip || null;
        kotPrinterPort = restRow.kot_printer_port || 9100;
        kotPrinterEnabled = !!restRow.kot_printer_enabled;
        restaurantName = restRow.name || '';
      } else if (restErr && /kitchen_workflow/i.test(restErr.message)) {
        const { data: baseRow } = await supabaseAdmin
          .from('tenants').select('name').eq('id', restaurant_id).single();
        restaurantName = baseRow?.name || '';
      }
    } catch (_) {}

    const shouldPrintKot =
      kotPrinterEnabled &&
      kotPrinterIp &&
      (kitchenWorkflow === 'KOT_only' || kitchenWorkflow === 'Both_KOT_and_KDS');

    if (shouldPrintKot && kdsItemsAdded > 0) {
      const kotLines = buildKotLines({
        restaurant_name: restaurantName,
        order_number: orderRow.order_number,
        token_number: token_number ?? null,
        table_number: table_number ?? null,
        service_type: service_type ?? null,
        special_notes: special_notes ?? null,
        items,
      });
      printKotEscPos({ ip: kotPrinterIp, port: kotPrinterPort, lines: kotLines })
        .then(() => console.log(`[kds-notify] 🖨 Network KOT sent to ${kotPrinterIp}:${kotPrinterPort}`))
        .catch((e) => console.warn(`[kds-notify] Network KOT failed (non-fatal): ${e.message}`));
    }

    broadcastToRestaurant(restaurant_id, {
      type:             'ORDER_NEW',
      order_id:         orderRow.id,
      order_number:     orderRow.order_number,
      token_number:     token_number   ?? null,
      table_number:     table_number   ?? null,
      customer_name:    customer_name  ?? null,
      customer_phone:   cleanPhone,
      service_type:     service_type   ?? null,
      special_notes:    special_notes  ?? null,
      advance_credit:   advance_credit || 0,
      item_count:       kdsItemsCreated,
      kitchen_workflow: kitchenWorkflow,
      source:           'whatsapp_booking',
      timestamp:        new Date().toISOString(),
    });

    // Receipt WhatsApp is sent by the Python chat agent (upload_and_send_receipt).
    // Sending here as well caused duplicate messages on webhook retries.

    // ── Step 7: Fulfillment groups (multi-counter takeaway) ───────────────────
    const isTA = service_type === 'takeaway' || service_type === 'whatsapp_booking';
    if (isTA) {
      try {
        const { data: rest } = await supabaseAdmin
          .from('tenants').select('takeaway_fulfillment_mode').eq('id', restaurant_id).single();

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

    // ── Step 8: Audit log (non-blocking) ────────────────────────────────────
    void (async () => {
      try {
        const { error: auditErr } = await supabaseAdmin.from('audit_logs').insert({
          restaurant_id,
          action:  'KDS items created via booking agent',
          details: { order_id: orderRow.id, order_number: orderRow.order_number, token_number, service_type, kds_items: kdsItemsCreated },
        });
        if (auditErr) {
          console.warn(`[kds-notify] audit log failed (non-fatal): ${auditErr.message}`);
        }
      } catch (auditEx) {
        console.warn(`[kds-notify] audit log failed (non-fatal): ${auditEx.message}`);
      }
    })();

    console.log(
      `[kds-notify] ✅ ${kdsItemsCreated} KDS item(s)` +
      ` | order ${orderRow.order_number}` +
      ` | token ${token_number ?? 'N/A'}` +
      ` | table ${table_number ?? 'N/A'}` +
      ` | restaurant ${restaurant_id}`
    );

    if (kdsItemsAdded === 0) {
      console.error(
        `[kds-notify] ❌ order ${orderRow.order_number} — 0 new KDS items added (${items.length} requested)`
      );
      return res.status(500).json({
        error:             'No KDS items could be created for this order',
        order_id:          orderRow.id,
        order_number:      orderRow.order_number,
        kds_items_created: kdsItemsCreated,
        kds_items_added:   0,
      });
    }

    return res.status(201).json({
      success:           true,
      order_id:          orderRow.id,
      order_number:      orderRow.order_number,
      kds_items_created: kdsItemsCreated,
      kds_items_added:   kdsItemsAdded,
      kot_ticket_id:     kotTicketId,
    });

  } catch (err) {
    console.error('[kds-notify] Unexpected error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/kds/order-notes — append kitchen notes to an existing order ──

router.patch('/order-notes', async (req, res) => {
  if (!isValidKdsSecret(extractInternalSecret(req))) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { restaurant_id, order_id, token_number, special_notes } = req.body;
  if (!restaurant_id || !special_notes) {
    return res.status(400).json({ error: 'restaurant_id and special_notes required' });
  }

  try {
    if (order_id) {
      await supabaseAdmin.from('orders')
        .update({ notes: special_notes })
        .eq('id', order_id)
        .eq('restaurant_id', restaurant_id);
    }

    let q = supabaseAdmin.from('kds_items')
      .update({ special_instructions: special_notes })
      .eq('restaurant_id', restaurant_id);
    if (order_id) {
      const { data: orderItems } = await supabaseAdmin.from('order_items')
        .select('id').eq('order_id', order_id);
      const ids = (orderItems ?? []).map(r => r.id);
      if (ids.length) q = q.in('order_item_id', ids);
    } else if (token_number) {
      q = q.eq('token_number', token_number);
    }
    const { error } = await q;
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('[kds-notes] update failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
