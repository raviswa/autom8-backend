'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin } = require('../../config/supabase');
const { authenticateToken, getRestaurantId } = require('../../middleware/auth');
const { writeAuditLog } = require('../../helpers/auditLog');
const { mapTimeSlot, getCurrentSlotIST, applySlotAvailability } = require('./shared/slots');
const { triggerMetaFeedRefetch, pushSingleItemToMetaCatalog } = require('./shared/meta');
const {
  exportCategoryLabel,
  exportTimeSlotLabel,
  parseBoolCell,
  parseKitchenStation,
} = require('./shared/uploadParse');
// ── POST /api/menu/upload (and /api/catalog/menu-upload) — Bulk menu upload ──

// AFTER
async function handleMenuUpload(req, res) {
  try {
    const OWNER_ROLES = ['owner', 'brand_owner'];
    if (!OWNER_ROLES.includes(req.user_role) && req.user_role !== 'manager') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (req.user_role === 'manager') {
      const { data: tenant, error: tenantErr } = await supabaseAdmin
        .from('tenants')
        .select('allow_manager_menu_upload')
        .eq('id', req.restaurant_id)
        .maybeSingle();
      if (tenantErr) {
        console.error('[menu/upload] permission lookup failed:', tenantErr.message);
        return res.status(500).json({ error: 'Could not verify upload permission' });
      }
      if (!tenant?.allow_manager_menu_upload) {
        return res.status(403).json({
          error: 'Menu upload is restricted to the owner for this outlet. Ask your owner to enable manager upload access in Settings.',
        });
      }
    }

    const { items } = req.body;
    if (!items || !Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'items array required' });

    const restaurantId = req.restaurant_id;
    let upserted = 0, skipped = 0, purged = 0;
    const errors = [];

    let packagedLob = false;
    let blockNoFssai = false;
    try {
      const { data: tenantRow } = await supabaseAdmin
        .from('tenants')
        .select('lob_type, fssai_license')
        .eq('id', restaurantId)
        .maybeSingle();
      packagedLob = ['food_products', 'retail', 'b2b', 'psl'].includes(
        String(tenantRow?.lob_type || '').toLowerCase(),
      );
      // Packaged food cannot go live for sale without an FSSAI license on file —
      // block publish rather than let it slip through as a checklist afterthought.
      blockNoFssai = String(tenantRow?.lob_type || '').toLowerCase() === 'food_products'
        && !String(tenantRow?.fssai_license || '').trim();
    } catch (_) { /* non-fatal */ }

    // Phase 0: remove duplicate retailer_id rows (keep newest)
    try {
      const { data: allRows } = await supabaseAdmin.from('menu_items')
        .select('id, retailer_id, updated_at').eq('restaurant_id', restaurantId)
        .not('retailer_id', 'is', null).order('updated_at', { ascending: false })
        .is('archived_at', null)
        .order('updated_at', { ascending: false });
      const seen = new Map(), dupIds = [];
      for (const row of allRows ?? []) {
        if (seen.has(row.retailer_id)) dupIds.push(row.id);
        else seen.set(row.retailer_id, row.id);
      }
      if (dupIds.length > 0) {
        await supabaseAdmin.from('menu_items').delete().in('id', dupIds);
        console.log(`[menu/upload] 🧹 Removed ${dupIds.length} duplicate rows`);
      }
    } catch (dedupErr) {
      console.warn('[menu/upload] Dedup failed (non-fatal):', dedupErr.message);
    }

    // Phase 1: parse + validate
    const validRows = [], payloadIds = [];
    for (const item of items) {
      const itemName   = item.name || item.title;
      const retailerId = item.retailer_id || item.id;
      if (!retailerId || !itemName) { errors.push({ row_id: retailerId, error: 'Missing retailer_id or name' }); skipped++; continue; }

      const price = parseFloat(item.price) || 0;
      if (price <= 0) { errors.push({ row_id: retailerId, error: `Invalid price: ${item.price}` }); skipped++; continue; }

      let isStocked = true;
      if (item.is_available !== undefined && item.is_available !== null && item.is_available !== '') {
        const raw = String(item.is_available).toLowerCase().trim();
        isStocked = raw === 'true' || raw === '1' || raw === 'yes';
      }
      const stockQty = item.current_stock != null && item.current_stock !== ''
        ? Math.max(0, parseInt(item.current_stock, 10) || 0)
        : null;
      if (stockQty === 0) isStocked = false;
      if (blockNoFssai) isStocked = false;

      payloadIds.push(String(retailerId).trim());
      const now = new Date().toISOString();
      const timeSlotRaw = item.time_slot ?? item.custom_label_0 ?? item['custom_label_0'] ?? '';
      validRows.push({
        restaurant_id:       restaurantId,
        retailer_id:         String(retailerId).trim(),
        name:                String(itemName).trim(),
        description:         String(item.description || '').trim(),
        price,
        image_url:           item.image_url || item.image_link || null,
        time_slot:           mapTimeSlot(timeSlotRaw),
        category:            String(item.category || '').trim() || 'General',
        is_stocked:          isStocked,
        is_available:        isStocked,
        prep_time_fixed:     Math.max(0, parseInt(item.prep_time_fixed, 10) || 5),
        batch_size:          Math.max(1, parseInt(item.batch_size, 10) || 1),
        time_per_batch:      Math.max(1, parseInt(item.time_per_batch, 10) || 10),
        kitchen_station:     (() => {
          if (item.kitchen_station) return parseKitchenStation(item.kitchen_station);
          return packagedLob ? 'sweets_counter' : 'assembly';
        })(),
        packing_time:        Math.max(0, parseFloat(item.packing_time) || 1),
        holds_well:          parseBoolCell(item.holds_well, false),
        fulfillment_section: String(item.fulfillment_section || 'main').trim() || 'main',
        item_type:           (() => {
          const t = String(item.item_type || 'PRODUCT').trim().toUpperCase() || 'PRODUCT';
          return (t === 'BUNDLE' || t === 'HAMPER') ? 'BUNDLE' : t;
        })(),
        variant_group_id:    item.variant_group_id ? String(item.variant_group_id).trim() : null,
        size_label:          (item.size_label || item.pack_size_label)
          ? String(item.size_label || item.pack_size_label).trim()
          : null,
        flavour_group:       item.flavour_group ? String(item.flavour_group).trim() : null,
        scoop_count:         Math.max(1, parseInt(item.scoop_count, 10) || 1),
        crust_options:       item.crust_options ? String(item.crust_options).trim() : null,
        toppings_allowed:    !!item.toppings_allowed,
        topping_extra_price: item.topping_extra_price != null ? parseFloat(item.topping_extra_price) || null : null,
        pack_size_label:     item.pack_size_label ? String(item.pack_size_label).trim() : null,
        weight_grams:        item.weight_grams != null && item.weight_grams !== '' ? parseInt(item.weight_grams, 10) || null : null,
        current_stock:       stockQty,
        shelf_life_days:     item.shelf_life_days != null && item.shelf_life_days !== '' ? parseInt(item.shelf_life_days, 10) || null : null,
        made_on_date:        item.made_on_date ? String(item.made_on_date).trim().slice(0, 10) : null,
        ingredients:         item.ingredients ? String(item.ingredients).trim() : null,
        allergens:           item.allergens ? String(item.allergens).trim() : null,
        availability_status: (() => {
          const raw = String(item.availability_status || '').toLowerCase().trim();
          if (['coming_soon', 'preorder', 'sold_out', 'in_stock'].includes(raw)) return raw;
          if (stockQty === 0) return 'sold_out';
          return null;
        })(),
        launch_at:           item.launch_at ? String(item.launch_at).trim() : null,
        deposit_amount:      item.deposit_amount != null && item.deposit_amount !== ''
          ? parseFloat(item.deposit_amount) || null
          : null,
        condition:           item.condition ? String(item.condition).trim() : null,
        original_mrp:        item.original_mrp != null && item.original_mrp !== '' ? parseFloat(item.original_mrp) || null : null,
        warranty_days:       item.warranty_days != null && item.warranty_days !== '' ? parseInt(item.warranty_days, 10) || null : null,
        colour:              item.colour ? String(item.colour).trim() : null,
        meta:                (() => {
          const base = (item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta))
            ? { ...item.meta }
            : {};
          if (Array.isArray(item.bundle_components) && item.bundle_components.length) {
            base.bundle_components = item.bundle_components;
          }
          return Object.keys(base).length ? base : {};
        })(),
        image_url_2:         item.image_url_2 || item.image_link_2 || null,
        image_url_3:         item.image_url_3 || item.image_link_3 || null,
        image_url_4:         item.image_url_4 || item.image_link_4 || null,
        image_url_5:         item.image_url_5 || item.image_link_5 || null,
        created_at:          now,
        updated_at:          now,
      });

      // Optional Excel discount_percent + discount_days → ends_at from upload time
      if (item.discount_percent && item.discount_days) {
        try {
          const { buildDiscountPatch } = require('../../helpers/menuDiscount');
          const built = buildDiscountPatch({
            discount_percent: item.discount_percent,
            duration_days: item.discount_days,
          });
          if (!built.error && built.patch) {
            Object.assign(validRows[validRows.length - 1], {
              discount_percent: built.patch.discount_percent,
              discount_ends_at: built.patch.discount_ends_at,
            });
          }
        } catch (_e) { /* non-fatal */ }
      }
    }

    if (!validRows.length) return res.status(400).json({ error: 'No valid rows found', skipped, errors });

    // Phase 2: full catalog replace — remove every existing item for this outlet
// Phase 2: soft-replace — archive everything currently active for this outlet.
// (A hard DELETE here fails atomically if any row is referenced by order_items,
//  which silently aborts the whole upload — this is what was letting stale
//  items and stale categories survive re-uploads.)
try {
  const nowIso = new Date().toISOString();
  const { data: archived, error: archiveErr } = await supabaseAdmin.from('menu_items')
    .update({ is_stocked: false, is_available: false, archived_at: nowIso, updated_at: nowIso })
    .eq('restaurant_id', restaurantId)
    .is('archived_at', null)
    .select('id');
  if (archiveErr) throw archiveErr;
  purged = archived?.length ?? 0;
  console.log(`[menu/upload] 🗄️ Archived ${purged} previous items (soft-replace)`);
} catch (archiveErr) {
  console.error('[menu/upload] Archive step failed:', archiveErr.message);
  return res.status(500).json({ error: `Could not archive existing catalog: ${archiveErr.message}` });
}

    // Phase 3: insert fresh rows
    for (const row of validRows) {
      try {
        const { error: dbErr } = await supabaseAdmin.from('menu_items').insert(row);
        if (dbErr) {
          errors.push({ row_id: row.retailer_id, error: dbErr.message });
          skipped++;
        } else {
          upserted++;
        }
      } catch (itemErr) {
        errors.push({ row_id: row.retailer_id, error: itemErr.message });
        skipped++;
      }
    }

    // Phase 4: audit
    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: restaurantId,
      action: 'Menu items uploaded via Excel', details: { upserted, skipped, purged },
    });

    // Phase 5: trigger Meta feed refetch
    triggerMetaFeedRefetch().catch(e => console.warn('[menu/upload] Meta trigger failed:', e.message));

    const response = { success: true, upserted, skipped, purged, total: items.length };
    if (errors.length) response.errors = errors;
    if (blockNoFssai) {
      response.warnings = [
        ...(response.warnings || []),
        'No FSSAI license on file — all items were uploaded as out-of-stock. '
          + 'Add your FSSAI license number in Settings, then re-upload to publish.',
      ];
    }
    res.json(response);
  } catch (err) {
    console.error('[menu/upload]', err.message);
    res.status(500).json({ error: err.message });
  }
}

const menuUploadMiddleware = [authenticateToken, getRestaurantId, handleMenuUpload];
router.post('/menu-upload', ...menuUploadMiddleware);

// ── PUT /api/menu-items/:id/availability — Toggle stock + Meta Catalog push ──

async function handleMenuItemAvailability(req, res) {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const { is_available } = req.body;
    if (typeof is_available !== 'boolean')
      return res.status(400).json({ error: 'is_available (boolean) required' });

    const { data: item, error: fetchErr } = await supabaseAdmin
      .from('menu_items').select('id, retailer_id, name, is_stocked, current_stock')
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id).single();

    if (fetchErr || !item) return res.status(404).json({ error: 'Menu item not found' });

    if (is_available) {
      const { data: tenantRow } = await supabaseAdmin
        .from('tenants').select('lob_type, fssai_license')
        .eq('id', req.restaurant_id).maybeSingle();
      const needsFssai = String(tenantRow?.lob_type || '').toLowerCase() === 'food_products'
        && !String(tenantRow?.fssai_license || '').trim();
      if (needsFssai) {
        return res.status(400).json({
          error: 'Add your FSSAI license number in Settings before marking packaged food items in stock.',
        });
      }
    }

    const wasOut = !item.is_stocked;
    const patch = {
      is_stocked:   is_available,
      is_available: is_available,
      updated_at:   new Date().toISOString(),
    };
    // Coming back in stock with qty tracking but zero left → bump to at least 1 unless client sends stock
    if (is_available && item.current_stock != null && Number(item.current_stock) <= 0) {
      if (req.body.current_stock != null) {
        patch.current_stock = Math.max(0, parseInt(req.body.current_stock, 10) || 0);
      }
    }
    if (req.body.current_stock != null && req.body.current_stock !== '') {
      patch.current_stock = Math.max(0, parseInt(req.body.current_stock, 10) || 0);
      if (patch.current_stock <= 0) {
        patch.is_stocked = false;
        patch.is_available = false;
      }
    }

    const { error: updateErr } = await supabaseAdmin.from('menu_items').update(patch)
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id);

    if (updateErr) throw updateErr;

    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: `Menu item ${is_available ? 'marked in stock' : 'marked out of stock'}`,
      details: { item_id: req.params.id, item_name: item.name, is_available, current_stock: patch.current_stock },
    });

    res.json({
      success: true,
      id: req.params.id,
      is_available: patch.is_available !== false && is_available,
      name: item.name,
      current_stock: patch.current_stock !== undefined ? patch.current_stock : item.current_stock,
    });

    if (item.retailer_id) {
      pushSingleItemToMetaCatalog({
        retailerId:   item.retailer_id,
        isAvailable:  patch.is_available !== false && !!is_available,
        restaurantId: req.restaurant_id,
      }).catch(e => console.error(`[toggle-meta-sync] Failed for ${item.name}:`, e.message));
    }

    if (wasOut && is_available && (patch.is_available !== false)) {
      try {
        const { notifyStockWaitlist } = require('../../helpers/inventory');
        const result = await notifyStockWaitlist(supabaseAdmin, {
          restaurantId: req.restaurant_id,
          menuItemId: item.id,
          retailerId: item.retailer_id,
          itemName: item.name,
        });
        if (result.notified) {
          console.log(`[stock-waitlist] Notified ${result.notified} for ${item.name}`);
        }
      } catch (wlErr) {
        console.warn('[stock-waitlist] notify failed:', wlErr.message);
      }
    }
  } catch (err) {
    console.error('[menu-item-availability]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

const menuItemAvailabilityMiddleware = [authenticateToken, getRestaurantId, handleMenuItemAvailability];
router.put('/menu-items/:id/availability', ...menuItemAvailabilityMiddleware);

// ── POST /api/menu-items/:id/restock — Add/set batch qty + waitlist notify ───

async function handleMenuItemRestock(req, res) {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const { restockItem, notifyStockWaitlist } = require('../../helpers/inventory');

    const result = await restockItem(supabaseAdmin, {
      restaurantId: req.restaurant_id,
      itemId: req.params.id,
      addQty: req.body.add_qty,
      setQty: req.body.set_qty ?? req.body.current_stock,
    });

    await writeAuditLog({
      user_id: req.user.sub,
      restaurant_id: req.restaurant_id,
      action: 'Menu item restocked',
      details: { item_id: result.id, item_name: result.name, current_stock: result.current_stock },
    });

    let waitlistNotified = 0;
    if (result.was_out && result.now_in_stock) {
      try {
        const n = await notifyStockWaitlist(supabaseAdmin, {
          restaurantId: req.restaurant_id,
          menuItemId: result.id,
          retailerId: result.retailer_id,
          itemName: result.name,
        });
        waitlistNotified = n.notified || 0;
      } catch (wlErr) {
        console.warn('[restock] waitlist notify:', wlErr.message);
      }
    }

    if (result.retailer_id) {
      pushSingleItemToMetaCatalog({
        retailerId: result.retailer_id,
        isAvailable: result.now_in_stock,
        restaurantId: req.restaurant_id,
      }).catch((e) => console.error('[restock-meta]', e.message));
    }

    res.json({
      success: true,
      ...result,
      waitlist_notified: waitlistNotified,
    });
  } catch (err) {
    console.error('[menu-item-restock]', err.message);
    res.status(500).json({ error: err.message });
  }
}

router.post('/menu-items/:id/restock', authenticateToken, getRestaurantId, handleMenuItemRestock);

// ── POST /api/menu-items/:id/launch — Flip coming-soon/preorder item live now ─

async function handleMenuItemLaunch(req, res) {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const { data: item, error: fetchErr } = await supabaseAdmin
      .from('menu_items')
      .select('id, retailer_id, name, availability_status, current_stock')
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id).single();
    if (fetchErr || !item) return res.status(404).json({ error: 'Menu item not found' });

    const { data: tenantRow } = await supabaseAdmin
      .from('tenants').select('lob_type, fssai_license')
      .eq('id', req.restaurant_id).maybeSingle();
    const needsFssai = String(tenantRow?.lob_type || '').toLowerCase() === 'food_products'
      && !String(tenantRow?.fssai_license || '').trim();
    if (needsFssai) {
      return res.status(400).json({
        error: 'Add your FSSAI license number in Settings before launching packaged food items.',
      });
    }

    const stockQty = item.current_stock != null ? Math.max(0, parseInt(item.current_stock, 10) || 0) : null;
    const { error: updateErr } = await supabaseAdmin.from('menu_items').update({
      availability_status: 'in_stock',
      is_stocked: stockQty === 0 ? false : true,
      is_available: stockQty === 0 ? false : true,
      launch_at: null,
      updated_at: new Date().toISOString(),
    }).eq('id', item.id).eq('restaurant_id', req.restaurant_id);
    if (updateErr) throw updateErr;

    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: 'Menu item launched (coming soon → live)', details: { item_id: item.id, item_name: item.name },
    });

    let waitlistNotified = 0;
    try {
      const { notifyStockWaitlist } = require('../../helpers/inventory');
      const n = await notifyStockWaitlist(supabaseAdmin, {
        restaurantId: req.restaurant_id,
        menuItemId: item.id,
        retailerId: item.retailer_id,
        itemName: item.name,
        reason: 'launch',
      });
      waitlistNotified = n.notified || 0;
    } catch (wlErr) {
      console.warn('[launch] waitlist notify:', wlErr.message);
    }

    res.json({ success: true, id: item.id, name: item.name, availability_status: 'in_stock', waitlist_notified: waitlistNotified });

    if (item.retailer_id) {
      pushSingleItemToMetaCatalog({
        retailerId: item.retailer_id,
        isAvailable: stockQty !== 0,
        restaurantId: req.restaurant_id,
      }).catch((e) => console.error('[launch-meta]', e.message));
    }
  } catch (err) {
    console.error('[menu-item-launch]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

router.post('/menu-items/:id/launch', authenticateToken, getRestaurantId, handleMenuItemLaunch);

// ── PUT /api/menu-items/:id/special-today — Mark special dish (no Meta push) ─

async function handleMenuItemSpecialToday(req, res) {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const {
      is_special_today,
      is_todays_special,
      special_note,
      recurring_special,
    } = req.body;
    const nextSpecial =
      typeof is_todays_special === 'boolean' ? is_todays_special : is_special_today;
    if (typeof nextSpecial !== 'boolean') {
      return res.status(400).json({ error: 'is_special_today/is_todays_special (boolean) required' });
    }

    const { data: item, error: fetchErr } = await supabaseAdmin
      .from('menu_items').select('id, name')
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id).single();

    if (fetchErr || !item) return res.status(404).json({ error: 'Menu item not found' });

    const patch = {
      is_special_today: nextSpecial,
      is_todays_special: nextSpecial,
      updated_at: new Date().toISOString(),
    };
    if (special_note !== undefined) patch.special_note = String(special_note || '').trim() || null;
    if (recurring_special !== undefined) patch.recurring_special = !!recurring_special;

    const { error: updateErr } = await supabaseAdmin.from('menu_items').update(patch)
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id);

    if (updateErr) {
      if (/is_special_today/i.test(updateErr.message)) {
        return res.status(500).json({
          error: 'Special dish feature not enabled — run migrations/add_catalog_parcel_and_specials.sql in Supabase.',
        });
      }
      throw updateErr;
    }

    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: nextSpecial ? "Marked today's special" : "Removed today's special",
      details: {
        item_id: req.params.id,
        item_name: item.name,
        is_special_today: nextSpecial,
        special_note: patch.special_note ?? null,
        recurring_special: patch.recurring_special ?? null,
      },
    });

    res.json({
      success: true,
      id: req.params.id,
      is_special_today: nextSpecial,
      is_todays_special: nextSpecial,
      special_note: patch.special_note ?? null,
      recurring_special: patch.recurring_special ?? false,
      name: item.name,
    });
  } catch (err) {
    console.error('[menu-item-special-today]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

const menuItemSpecialTodayMiddleware = [authenticateToken, getRestaurantId, handleMenuItemSpecialToday];
router.put('/menu-items/:id/special-today', ...menuItemSpecialTodayMiddleware);

// ── PUT /api/menu-items/:id/discount — X% off for next Y days ───────────────

async function handleMenuItemDiscount(req, res) {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { buildDiscountPatch, deriveMenuDiscount } = require('../../helpers/menuDiscount');
    const built = buildDiscountPatch(req.body || {});
    if (built.error) return res.status(400).json({ error: built.error });

    const { data: item, error: fetchErr } = await supabaseAdmin
      .from('menu_items')
      .select('id, name, price, discount_percent, discount_ends_at')
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id)
      .single();

    if (fetchErr || !item) return res.status(404).json({ error: 'Menu item not found' });

    const { error: updateErr } = await supabaseAdmin
      .from('menu_items')
      .update(built.patch)
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id);

    if (updateErr) {
      if (/discount_percent|discount_ends_at/i.test(updateErr.message || '')) {
        return res.status(500).json({
          error: 'Discount columns missing — run migrations/20260721_menu_item_discounts.sql in Supabase.',
        });
      }
      throw updateErr;
    }

    const next = {
      ...item,
      price: item.price,
      discount_percent: built.patch.discount_percent,
      discount_ends_at: built.patch.discount_ends_at,
    };
    const derived = deriveMenuDiscount(next);

    await writeAuditLog({
      user_id: req.user.sub,
      restaurant_id: req.restaurant_id,
      action: built.cleared ? 'Cleared item discount' : 'Set item discount',
      details: {
        item_id: req.params.id,
        item_name: item.name,
        discount_percent: derived.discount_percent,
        discount_ends_at: derived.discount_ends_at,
        duration_days: built.duration_days || null,
      },
    });

    res.json({
      success: true,
      id: req.params.id,
      name: item.name,
      cleared: !!built.cleared,
      discount_percent: derived.discount_percent,
      discount_ends_at: derived.discount_ends_at,
      discount_active: derived.discount_active,
      discount_days_left: derived.discount_days_left,
      list_price: derived.list_price,
      effective_price: derived.effective_price,
    });
  } catch (err) {
    console.error('[menu-item-discount]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

const menuItemDiscountMiddleware = [authenticateToken, getRestaurantId, handleMenuItemDiscount];
router.put('/menu-items/:id/discount', ...menuItemDiscountMiddleware);

/** Clear all is_special_today flags (called daily at midnight IST). */
async function resetDailySpecialDishes() {
  const { data, error } = await supabaseAdmin
    .from('menu_items')
    .update({ is_special_today: false, is_todays_special: false, updated_at: new Date().toISOString() })
    .or('is_special_today.eq.true,is_todays_special.eq.true')
    .eq('recurring_special', false)
    .select('id');

  if (error) {
    console.error('[special-dish-reset] Error:', error.message);
    return 0;
  }
  const n = data?.length ?? 0;
  if (n) console.log(`[special-dish-reset] Cleared ${n} special-dish flag(s)`);
  return n;
}

module.exports = router;
module.exports.handleMenuUpload = handleMenuUpload;
module.exports.menuUploadMiddleware = menuUploadMiddleware;
module.exports.menuItemAvailabilityMiddleware = menuItemAvailabilityMiddleware;
module.exports.menuItemSpecialTodayMiddleware = menuItemSpecialTodayMiddleware;
module.exports.menuItemDiscountMiddleware = menuItemDiscountMiddleware;
module.exports.resetDailySpecialDishes = resetDailySpecialDishes;
