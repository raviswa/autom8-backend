'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin } = require('../../config/supabase');
const { authenticateToken, getRestaurantId } = require('../../middleware/auth');
const { writeAuditLog } = require('../../helpers/auditLog');
const { mapTimeSlot, getCurrentSlotIST, applySlotAvailability } = require('./shared/slots');
const { triggerMetaFeedRefetch, pushSingleItemToMetaCatalog } = require('./shared/meta');
const { deriveRetailerId, productMatchKey } = require('../../helpers/retailerId');
const {
  exportCategoryLabel,
  exportTimeSlotLabel,
  parseBoolCell,
  resolveKitchenStation,
  isReadymadeCategory,
} = require('./shared/uploadParse');
const { recordActivationEvent } = require('../../helpers/tenantActivation');
const { normalizePublicImageUrl } = require('../../helpers/publicImageUrl');

function bustWebcartMenuCache(restaurantId) {
  try {
    const { invalidateMenuCache } = require('../webcart/shared');
    invalidateMenuCache(restaurantId);
  } catch (e) {
    console.warn('[menu-items] menu cache invalidate skipped:', e.message);
  }
}
// ── POST /api/menu/upload (and /api/catalog/menu-upload) — Bulk menu upload ──

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
    const mode = req.body.mode === 'replace' ? 'replace' : 'merge';
    const missingPolicy = ['keep', 'sold_out', 'archive'].includes(req.body.missing_policy)
      ? req.body.missing_policy
      : (mode === 'replace' ? 'archive' : 'keep');
    let stockPolicy = ['leave', 'add', 'replace'].includes(req.body.stock_policy)
      ? req.body.stock_policy
      : 'leave';
    let created = 0, updated = 0, skipped = 0, archived = 0, markedSoldOut = 0;
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

    // Restaurant / dine-in templates have no stock qty column — never rewrite batch stock from Excel.
    // Cooked items use the in-stock toggle (current_stock NULL = unlimited). Packaged LOBs use Record batch.
    if (!packagedLob && stockPolicy !== 'leave') {
      stockPolicy = 'leave';
    }

    const { data: existingRows, error: existingErr } = await supabaseAdmin
      .from('menu_items')
      .select('id, retailer_id, name, pack_size_label, size_label, current_stock, is_stocked, is_available, archived_at, kitchen_station, category')
      .eq('restaurant_id', restaurantId)
      .order('updated_at', { ascending: false });
    if (existingErr) throw existingErr;

    const existingByRetailerId = new Map();
    const existingByProductKey = new Map();
    for (const row of existingRows || []) {
      const retailerKey = String(row.retailer_id || '').trim().toUpperCase();
      if (retailerKey && !existingByRetailerId.has(retailerKey)) existingByRetailerId.set(retailerKey, row);
      const productKey = productMatchKey(row.name, row.pack_size_label || row.size_label);
      if (!existingByProductKey.has(productKey)) existingByProductKey.set(productKey, row);
    }

    const reservedIds = new Set(existingByRetailerId.keys());
    const payloadIds = new Set();
    const validRows = [];
    const warnings = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const itemName   = item.name || item.title;
      if (!itemName) {
        errors.push({ row: index + 1, row_id: item.retailer_id || item.id || null, error: 'Missing name' });
        skipped++;
        continue;
      }

      const price = parseFloat(item.price) || 0;
      if (price <= 0) {
        errors.push({ row: index + 1, row_id: item.retailer_id || item.id || null, error: `Invalid price: ${item.price}` });
        skipped++;
        continue;
      }

      const packSizeLabel = item.pack_size_label || item.size_label || null;
      const matchedByProduct = existingByProductKey.get(productMatchKey(itemName, packSizeLabel));
      const excelIdRaw = String(item.retailer_id || item.id || '').trim();
      const excelIdKey = excelIdRaw.toUpperCase();

      let retailerId;
      let idWarning = null;
      if (matchedByProduct) {
        // Product match: keep stable retailer_id — never steal another SKU's id.
        const takenByOther = excelIdKey
          ? existingByRetailerId.get(excelIdKey)
          : null;
        if (
          excelIdRaw
          && takenByOther
          && takenByOther.id !== matchedByProduct.id
        ) {
          retailerId = matchedByProduct.retailer_id;
          idWarning = `Excel id "${excelIdRaw}" already used by another item — kept existing id "${retailerId}"`;
        } else if (
          excelIdRaw
          && String(matchedByProduct.retailer_id || '').toUpperCase() === excelIdKey
        ) {
          retailerId = matchedByProduct.retailer_id;
        } else if (excelIdRaw && !takenByOther) {
          // Unused excel id on product-matched row — keep existing to avoid Meta/catalog churn
          retailerId = matchedByProduct.retailer_id;
          if (excelIdKey !== String(matchedByProduct.retailer_id || '').toUpperCase()) {
            idWarning = `Ignored Excel id "${excelIdRaw}" on update — kept existing id "${retailerId}"`;
          }
        } else {
          retailerId = matchedByProduct.retailer_id;
        }
      } else if (excelIdRaw) {
        const taken = existingByRetailerId.get(excelIdKey);
        if (taken) {
          // Excel id belongs to an existing row that did not product-match — autogenerate
          retailerId = deriveRetailerId({
            name: itemName,
            packSizeLabel,
            existingIds: Array.from(reservedIds),
          });
          idWarning = `Excel id "${excelIdRaw}" already in catalog — assigned new id "${retailerId}"`;
        } else {
          retailerId = excelIdRaw;
        }
      } else {
        retailerId = deriveRetailerId({
          name: itemName,
          packSizeLabel,
          existingIds: Array.from(reservedIds),
        });
      }

      if (idWarning) {
        warnings.push({ row: index + 1, row_id: retailerId, warning: idWarning });
      }

      const retailerKey = String(retailerId).toUpperCase();
      if (payloadIds.has(retailerKey)) {
        // Same file duplicate after conflict resolution — regenerate
        retailerId = deriveRetailerId({
          name: itemName,
          packSizeLabel,
          existingIds: Array.from(reservedIds).concat(Array.from(payloadIds)),
        });
        warnings.push({
          row: index + 1,
          row_id: retailerId,
          warning: 'Duplicate id in file — assigned a unique auto id',
        });
      }
      payloadIds.add(String(retailerId).toUpperCase());
      reservedIds.add(String(retailerId).toUpperCase());

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

      const category = String(item.category || '').trim() || 'General';
      const excelStationRaw = item.kitchen_station;
      const excelStationBlank = excelStationRaw === undefined
        || excelStationRaw === null
        || String(excelStationRaw).trim() === '';

      const now = new Date().toISOString();
      const timeSlotRaw = item.time_slot ?? item.custom_label_0 ?? item['custom_label_0'] ?? '';
      const rowOut = {
        restaurant_id:       restaurantId,
        retailer_id:         retailerId,
        name:                String(itemName).trim(),
        description:         String(item.description || '').trim(),
        price,
        image_url:           item.image_url || item.image_link || null,
        time_slot:           mapTimeSlot(timeSlotRaw),
        category,
        is_stocked:          isStocked,
        is_available:        isStocked,
        prep_time_fixed:     Math.max(0, parseInt(item.prep_time_fixed, 10) || 5),
        batch_size:          Math.max(1, parseInt(item.batch_size, 10) || 1),
        time_per_batch:      Math.max(1, parseInt(item.time_per_batch, 10) || 10),
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
        low_stock_alert_units: (() => {
          if (item.low_stock_alert_units == null || item.low_stock_alert_units === '') return packagedLob ? 5 : null;
          const n = parseInt(item.low_stock_alert_units, 10);
          return Number.isFinite(n) && n >= 0 ? n : (packagedLob ? 5 : null);
        })(),
        shelf_life_days:     item.shelf_life_days != null && item.shelf_life_days !== '' ? parseInt(item.shelf_life_days, 10) || null : null,
        made_on_date:        item.made_on_date ? String(item.made_on_date).trim().slice(0, 10) : null,
        ingredients:         item.ingredients ? String(item.ingredients).trim() : null,
        how_to_use:          item.how_to_use ? String(item.how_to_use).trim() : null,
        how_to_store:        item.how_to_store ? String(item.how_to_store).trim() : null,
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
        // Internal flags for update vs insert station handling (stripped before write)
        _excel_station_blank: excelStationBlank,
        _matched_product_id: matchedByProduct?.id || null,
        _existing_station: matchedByProduct?.kitchen_station || null,
      };

      if (!excelStationBlank) {
        rowOut.kitchen_station = resolveKitchenStation(excelStationRaw, {
          category,
          packagedLob,
        });
      } else if (!matchedByProduct) {
        // Insert with blank station — resolve from category
        rowOut.kitchen_station = resolveKitchenStation('', {
          category,
          packagedLob,
        });
      }
      // else: update with blank station — omit kitchen_station so DB value is preserved
      // (unless we upgrade assembly → sweets_counter for readymade below in write loop)

      validRows.push(rowOut);

      // Optional Excel discount_percent + discount_days → ends_at from upload time.
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

    async function writeRow(kind, targetId, row) {
      let query = kind === 'update'
        ? supabaseAdmin.from('menu_items').update(row).eq('id', targetId).eq('restaurant_id', restaurantId)
        : supabaseAdmin.from('menu_items').insert(row);
      let { error } = await query;
      if (error && /menu_items\.meta|['"]meta['"] column|column ['"]?meta/i.test(error.message || '')) {
        const withoutMeta = { ...row };
        delete withoutMeta.meta;
        query = kind === 'update'
          ? supabaseAdmin.from('menu_items').update(withoutMeta).eq('id', targetId).eq('restaurant_id', restaurantId)
          : supabaseAdmin.from('menu_items').insert(withoutMeta);
        ({ error } = await query);
      }
      return error;
    }

    function stripUploadFlags(row) {
      const out = { ...row };
      delete out._excel_station_blank;
      delete out._matched_product_id;
      delete out._existing_station;
      return out;
    }

    for (const rawRow of validRows) {
      try {
        const row = stripUploadFlags(rawRow);
        const existing = existingByRetailerId.get(String(row.retailer_id).toUpperCase())
          || existingByProductKey.get(productMatchKey(row.name, row.pack_size_label || row.size_label));
        let dbErr;
        if (existing) {
          const patch = { ...row, archived_at: null };
          delete patch.restaurant_id;
          delete patch.created_at;
          // Blank Excel station: preserve DB value (do not wipe sweets_counter → assembly).
          // Upgrade legacy assembly → sweets_counter when category is readymade.
          if (rawRow._excel_station_blank) {
            delete patch.kitchen_station;
            const dbStation = String(existing.kitchen_station || '').toLowerCase();
            if (
              isReadymadeCategory(row.category)
              && (!dbStation || dbStation === 'assembly')
            ) {
              patch.kitchen_station = 'sweets_counter';
            }
          }
          // Never change retailer_id on product-matched update (conflict-safe)
          if (String(existing.retailer_id || '').toUpperCase() !== String(row.retailer_id).toUpperCase()) {
            patch.retailer_id = existing.retailer_id;
          }
          if (stockPolicy === 'leave') {
            delete patch.made_on_date;
            if (packagedLob) {
              // Packaged: Excel is for product metadata; batch qty stays via Record batch / stock_policy.
              delete patch.current_stock;
              delete patch.is_stocked;
              delete patch.is_available;
              delete patch.availability_status;
            } else {
              // Restaurant: is_available in Excel drives the on/off toggle (no is_stocked column).
              // Clear zeroed batch qty so prepared dishes are unlimited when marked available.
              if (row.is_stocked) {
                patch.is_stocked = true;
                patch.is_available = true;
                patch.current_stock = null;
                patch.availability_status = 'in_stock';
              } else {
                patch.is_stocked = false;
                patch.is_available = false;
                delete patch.current_stock;
                patch.availability_status = 'sold_out';
              }
            }
          } else if (row.current_stock == null) {
            // Blank Excel stock cell = leave existing qty (schema: blank = unlimited / unchanged).
            // Never coerce null → 0 — that zeroed entire restaurant catalogs on "replace".
            delete patch.current_stock;
            delete patch.is_stocked;
            delete patch.is_available;
            delete patch.availability_status;
            delete patch.made_on_date;
          } else {
            const uploaded = Number(row.current_stock);
            const nextStock = stockPolicy === 'add'
              ? Math.max(0, Number(existing.current_stock || 0) + uploaded)
              : Math.max(0, uploaded);
            patch.current_stock = nextStock;
            patch.is_stocked = !blockNoFssai && nextStock > 0;
            patch.is_available = patch.is_stocked;
            patch.availability_status = nextStock > 0 ? 'in_stock' : 'sold_out';
          }
          if (row.low_stock_alert_units == null) delete patch.low_stock_alert_units;
          dbErr = await writeRow('update', existing.id, patch);
          if (!dbErr) updated++;
        } else {
          if (!row.kitchen_station) {
            row.kitchen_station = resolveKitchenStation('', {
              category: row.category,
              packagedLob,
            });
          }
          dbErr = await writeRow('insert', null, row);
          if (
            dbErr
            && /menu_items_restaurant_id_retailer_id_key|duplicate key/i.test(dbErr.message || '')
          ) {
            const retryId = deriveRetailerId({
              name: row.name,
              packSizeLabel: row.pack_size_label || row.size_label,
              existingIds: Array.from(reservedIds),
            });
            reservedIds.add(String(retryId).toUpperCase());
            row.retailer_id = retryId;
            warnings.push({
              row_id: retryId,
              warning: `Insert id conflict — retried as "${retryId}"`,
            });
            dbErr = await writeRow('insert', null, row);
          }
          if (!dbErr) created++;
        }
        if (dbErr) {
          errors.push({ row_id: row.retailer_id, error: dbErr.message });
          skipped++;
        }
      } catch (itemErr) {
        errors.push({ row_id: rawRow.retailer_id, error: itemErr.message });
        skipped++;
      }
    }

    const upserted = created + updated;
    if (upserted === 0) {
      return res.status(500).json({
        error: 'No catalog items were saved. Your existing catalog was left unchanged.',
        created, updated, skipped, total: items.length, errors,
      });
    }

    const liveMissing = (existingRows || []).filter((row) =>
      !row.archived_at && row.retailer_id && !payloadIds.has(String(row.retailer_id).trim().toUpperCase()));
    if (missingPolicy !== 'keep' && liveMissing.length) {
      const ids = liveMissing.map((row) => row.id);
      const now = new Date().toISOString();
      const patch = missingPolicy === 'archive'
        ? { is_stocked: false, is_available: false, archived_at: now, updated_at: now }
        : { is_stocked: false, is_available: false, availability_status: 'sold_out', updated_at: now };
      const { data: changed, error: missingErr } = await supabaseAdmin
        .from('menu_items')
        .update(patch)
        .eq('restaurant_id', restaurantId)
        .in('id', ids)
        .select('id');
      if (missingErr) errors.push({ error: `Could not apply missing-item policy: ${missingErr.message}` });
      else if (missingPolicy === 'archive') archived = changed?.length || 0;
      else markedSoldOut = changed?.length || 0;
    }

    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: restaurantId,
      action: 'Menu items uploaded via Excel',
      details: { mode, missing_policy: missingPolicy, stock_policy: stockPolicy, created, updated, skipped, archived, marked_sold_out: markedSoldOut },
    });

    recordActivationEvent(restaurantId, 'catalog_uploaded', {
      upserted: created + updated,
      source: 'menu_upload',
    }).catch(() => {});

    triggerMetaFeedRefetch().catch(e => console.warn('[menu/upload] Meta trigger failed:', e.message));

    const response = {
      success: true,
      mode,
      created,
      updated,
      upserted,
      skipped,
      archived,
      marked_sold_out: markedSoldOut,
      not_in_file: liveMissing.length,
      total: items.length,
      item_ids: validRows.map((row) => row.retailer_id),
    };
    if (errors.length) response.errors = errors;
    const allWarnings = [
      ...(warnings || []),
      ...(blockNoFssai
        ? [{
          warning:
            'No FSSAI license on file — all items were uploaded as out-of-stock. '
            + 'Add your FSSAI license number in Settings, then re-upload to publish.',
        }]
        : []),
    ];
    if (allWarnings.length) {
      response.warnings = allWarnings.map((w) => (typeof w === 'string' ? w : w.warning || JSON.stringify(w)));
    }
    bustWebcartMenuCache(restaurantId);
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
    // Coming back in stock with qty tracking but zero left:
    // - restaurant (toggle model): clear qty → NULL = unlimited prepared food
    // - packaged: bump to at least 1 unless client sends an explicit qty
    if (is_available && item.current_stock != null && Number(item.current_stock) <= 0) {
      if (req.body.current_stock != null && req.body.current_stock !== '') {
        patch.current_stock = Math.max(0, parseInt(req.body.current_stock, 10) || 0);
      } else {
        const { data: tenantRow2 } = await supabaseAdmin
          .from('tenants').select('lob_type')
          .eq('id', req.restaurant_id).maybeSingle();
        const packaged = ['food_products', 'retail', 'b2b', 'psl'].includes(
          String(tenantRow2?.lob_type || '').toLowerCase(),
        );
        patch.current_stock = packaged ? 1 : null;
        patch.availability_status = 'in_stock';
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

// ── POST /api/menu-items/mark-all-stocked — Restaurant recovery after bad stock replace ──
// Sets active items to toggle-style in-stock (current_stock NULL = unlimited prepared food).
// Packaged LOBs should use Record batch instead.

async function handleMarkAllStocked(req, res) {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const { data: tenantRow } = await supabaseAdmin
      .from('tenants').select('lob_type')
      .eq('id', req.restaurant_id).maybeSingle();
    const packaged = ['food_products', 'retail', 'b2b', 'psl'].includes(
      String(tenantRow?.lob_type || '').toLowerCase(),
    );
    if (packaged) {
      return res.status(400).json({
        error: 'Packaged catalogs use Record batch for stock. Mark all stocked is for restaurant / prepared-food menus.',
      });
    }

    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('menu_items')
      .update({
        is_stocked: true,
        is_available: true,
        current_stock: null,
        availability_status: 'in_stock',
        updated_at: now,
      })
      .eq('restaurant_id', req.restaurant_id)
      .is('archived_at', null)
      .select('id');

    if (error) throw error;

    await writeAuditLog({
      user_id: req.user.sub,
      restaurant_id: req.restaurant_id,
      action: 'Marked all active menu items in stock (unlimited)',
      details: { count: data?.length ?? 0 },
    });

    res.json({ success: true, marked: data?.length ?? 0 });
  } catch (err) {
    console.error('[menu-items-mark-all-stocked]', err.message);
    res.status(500).json({ error: err.message });
  }
}

const menuItemMarkAllStockedMiddleware = [authenticateToken, getRestaurantId, handleMarkAllStocked];
router.post('/menu-items/mark-all-stocked', ...menuItemMarkAllStockedMiddleware);

// ── GET /api/menu-items/stock-alerts — Today's low-stock / sold-out alerts ───

async function handleListStockAlerts(req, res) {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });
    const { listStockAlertsForDay, istDayKey } = require('../../helpers/stockAlerts');
    const day = req.query.day || istDayKey();
    const alerts = await listStockAlertsForDay(supabaseAdmin, req.restaurant_id, day);
    res.json({ success: true, day, alerts });
  } catch (err) {
    console.error('[menu-items-stock-alerts]', err.message);
    res.status(500).json({ error: err.message });
  }
}

const menuItemStockAlertsMiddleware = [authenticateToken, getRestaurantId, handleListStockAlerts];
router.get('/menu-items/stock-alerts', ...menuItemStockAlertsMiddleware);

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

const menuItemRestockMiddleware = [authenticateToken, getRestaurantId, handleMenuItemRestock];
router.post('/menu-items/:id/restock', ...menuItemRestockMiddleware);

// ── POST /api/menu-items/bulk-restock — Record one production batch ─────────

async function handleBulkMenuItemRestock(req, res) {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!lines.length) return res.status(400).json({ error: 'At least one batch line is required' });
    if (lines.length > 250) return res.status(400).json({ error: 'A batch can contain at most 250 items' });

    const defaultMadeOnDate = String(req.body.made_on_date || '').trim().slice(0, 10) || null;
    const { restockItem, notifyStockWaitlist } = require('../../helpers/inventory');
    const results = [];
    const errors = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] || {};
      const itemId = String(line.item_id || '').trim();
      const receivedQty = Math.floor(Number(line.received_qty ?? line.add_qty));
      const madeOnDate = String(line.made_on_date || defaultMadeOnDate || '').trim().slice(0, 10) || null;
      if (!itemId || !Number.isFinite(receivedQty) || receivedQty <= 0) {
        errors.push({ row: index + 1, item_id: itemId || null, error: 'item_id and a positive received_qty are required' });
        continue;
      }

      try {
        const result = await restockItem(supabaseAdmin, {
          restaurantId: req.restaurant_id,
          itemId,
          addQty: receivedQty,
        });

        if (madeOnDate) {
          const { error: dateErr } = await supabaseAdmin
            .from('menu_items')
            .update({ made_on_date: madeOnDate, updated_at: new Date().toISOString() })
            .eq('id', itemId)
            .eq('restaurant_id', req.restaurant_id);
          if (dateErr) throw dateErr;
        }

        let waitlistNotified = 0;
        if (result.was_out && result.now_in_stock) {
          const notification = await notifyStockWaitlist(supabaseAdmin, {
            restaurantId: req.restaurant_id,
            menuItemId: result.id,
            retailerId: result.retailer_id,
            itemName: result.name,
          });
          waitlistNotified = notification.notified || 0;
        }

        const { error: batchLogErr } = await supabaseAdmin.from('stock_batches').insert({
          restaurant_id: req.restaurant_id,
          menu_item_id: result.id,
          qty_added: receivedQty,
          made_on_date: madeOnDate,
          created_by: req.user.sub,
        });
        if (batchLogErr && !/stock_batches|pgrst205|42p01/i.test(batchLogErr.message || '')) {
          console.warn('[bulk-restock] batch history insert failed:', batchLogErr.message);
        }

        if (result.retailer_id) {
          pushSingleItemToMetaCatalog({
            retailerId: result.retailer_id,
            isAvailable: result.now_in_stock,
            restaurantId: req.restaurant_id,
          }).catch((error) => console.error('[bulk-restock-meta]', error.message));
        }

        results.push({
          ...result,
          received_qty: receivedQty,
          made_on_date: madeOnDate,
          waitlist_notified: waitlistNotified,
        });
      } catch (lineErr) {
        errors.push({ row: index + 1, item_id: itemId, error: lineErr.message });
      }
    }

    if (!results.length) {
      return res.status(400).json({ error: 'No stock was added', results, errors });
    }

    await writeAuditLog({
      user_id: req.user.sub,
      restaurant_id: req.restaurant_id,
      action: 'Recorded new stock batch',
      details: {
        items_updated: results.length,
        units_added: results.reduce((sum, row) => sum + row.received_qty, 0),
        made_on_date: defaultMadeOnDate,
        failed: errors.length,
      },
    });

    res.json({
      success: errors.length === 0,
      partial: errors.length > 0,
      items_updated: results.length,
      units_added: results.reduce((sum, row) => sum + row.received_qty, 0),
      waitlist_notified: results.reduce((sum, row) => sum + row.waitlist_notified, 0),
      results,
      errors,
    });
  } catch (err) {
    console.error('[bulk-menu-item-restock]', err.message);
    res.status(500).json({ error: err.message });
  }
}

const menuItemBulkRestockMiddleware = [authenticateToken, getRestaurantId, handleBulkMenuItemRestock];
router.post('/menu-items/bulk-restock', ...menuItemBulkRestockMiddleware);

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

const menuItemLaunchMiddleware = [authenticateToken, getRestaurantId, handleMenuItemLaunch];
router.post('/menu-items/:id/launch', ...menuItemLaunchMiddleware);

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

// ── Single-item CRUD (food products UI editor; Excel remains for bulk) ───────

async function assertMenuCatalogEditPermission(req) {
  const OWNER_ROLES = ['owner', 'brand_owner'];
  if (!OWNER_ROLES.includes(req.user_role) && req.user_role !== 'manager') {
    return { status: 403, error: 'Unauthorized' };
  }
  if (req.user_role === 'manager') {
    const { data: tenant, error: tenantErr } = await supabaseAdmin
      .from('tenants')
      .select('allow_manager_menu_upload')
      .eq('id', req.restaurant_id)
      .maybeSingle();
    if (tenantErr) {
      console.error('[menu-items/crud] permission lookup failed:', tenantErr.message);
      return { status: 500, error: 'Could not verify edit permission' };
    }
    if (!tenant?.allow_manager_menu_upload) {
      return {
        status: 403,
        error: 'Catalog editing is restricted to the owner for this outlet. Ask your owner to enable manager upload access in Settings.',
      };
    }
  }
  return null;
}

function parseBundleComponentsBody(raw) {
  if (Array.isArray(raw)) {
    const out = [];
    for (const part of raw) {
      if (!part || typeof part !== 'object') continue;
      const rid = String(part.retailer_id || part.id || '').trim();
      if (!rid) continue;
      const qty = Math.max(1, parseInt(part.qty ?? part.quantity ?? 1, 10) || 1);
      out.push({ retailer_id: rid, qty });
    }
    return out.length ? out : null;
  }
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const parts = text.split(/[,;|]/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const m = part.match(/^([A-Za-z0-9_-]+)\s*[:=xX×*]?\s*(\d+)?$/);
    if (!m) continue;
    const qty = Math.max(1, parseInt(m[2] || '1', 10) || 1);
    out.push({ retailer_id: m[1], qty });
  }
  return out.length ? out : null;
}

function validateHttpUrl(value, fieldLabel) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    return `${fieldLabel} must start with http:// or https://`;
  }
  return null;
}

function normalizeMenuItemBody(item, { packagedLob, existingMeta, lobType }) {
  const name = String(item.name || item.title || '').trim();
  const price = parseFloat(item.price);
  const pack = item.pack_size_label || item.size_label
    ? String(item.pack_size_label || item.size_label).trim()
    : null;
  const itemTypeRaw = String(item.item_type || 'PRODUCT').trim().toUpperCase() || 'PRODUCT';
  // Preserve PSL types (PIZZA, CUP, FLAVOUR, …); map HAMPER → BUNDLE; default PRODUCT.
  const PSL_TYPES = new Set(['PIZZA', 'CUP', 'CONE', 'SUNDAE', 'FLAVOUR', 'ADDON', 'PRODUCT', 'BUNDLE']);
  let item_type = 'PRODUCT';
  if (itemTypeRaw === 'HAMPER' || itemTypeRaw === 'BUNDLE') item_type = 'BUNDLE';
  else if (PSL_TYPES.has(itemTypeRaw)) item_type = itemTypeRaw;
  else if (itemTypeRaw) item_type = itemTypeRaw;

  const components = parseBundleComponentsBody(
    item.bundle_components != null ? item.bundle_components : item.bundle_components_text,
  );
  const availRaw = String(item.availability_status || '').toLowerCase().trim();
  const availability_status = ['coming_soon', 'preorder', 'sold_out', 'in_stock'].includes(availRaw)
    ? availRaw
    : null;

  const errors = [];
  if (!name) errors.push('Name is required');
  const priceOptional = item_type === 'FLAVOUR';
  if (!priceOptional && (!Number.isFinite(price) || price <= 0)) {
    errors.push('Price must be greater than 0');
  }
  if (Number.isFinite(price) && price < 0) errors.push('Price cannot be negative');
  if (item.variant_group_id && !pack) {
    errors.push('variant_group_id needs pack_size_label / size_label');
  }
  if (item_type === 'BUNDLE' && (!components || !components.length)) {
    errors.push('BUNDLE items need bundle_components (e.g. MP-100:3)');
  }
  for (const [key, label] of [
    ['image_url', 'image_url'],
    ['image_url_2', 'image_url_2'],
    ['image_url_3', 'image_url_3'],
    ['image_url_4', 'image_url_4'],
    ['image_url_5', 'image_url_5'],
  ]) {
    const err = validateHttpUrl(item[key] || (key === 'image_url' ? item.image_link : null), label);
    if (err) errors.push(err);
  }

  const category = String(item.category || '').trim() || 'General';
  const metaBase = (existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta))
    ? { ...existingMeta }
    : ((item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta)) ? { ...item.meta } : {});
  if (components) metaBase.bundle_components = components;
  else if (item_type !== 'BUNDLE') delete metaBase.bundle_components;

  const timeSlotRaw = item.time_slot ?? item.custom_label_0 ?? '';
  const row = {
    name,
    description: String(item.description || '').trim(),
    price: Number.isFinite(price) ? price : 0,
    category,
    image_url: normalizePublicImageUrl(item.image_url || item.image_link) || null,
    time_slot: mapTimeSlot(timeSlotRaw || 'all'),
    item_type,
    variant_group_id: item.variant_group_id ? String(item.variant_group_id).trim() : null,
    size_label: pack,
    pack_size_label: pack,
    weight_grams: item.weight_grams != null && item.weight_grams !== ''
      ? parseInt(item.weight_grams, 10) || null
      : null,
    availability_status,
    launch_at: item.launch_at ? String(item.launch_at).trim() : null,
    deposit_amount: item.deposit_amount != null && item.deposit_amount !== ''
      ? parseFloat(item.deposit_amount) || null
      : null,
    shelf_life_days: item.shelf_life_days != null && item.shelf_life_days !== ''
      ? parseInt(item.shelf_life_days, 10) || null
      : null,
    made_on_date: item.made_on_date ? String(item.made_on_date).trim().slice(0, 10) : null,
    ingredients: item.ingredients ? String(item.ingredients).trim() : null,
    how_to_use: item.how_to_use ? String(item.how_to_use).trim() : null,
    how_to_store: item.how_to_store ? String(item.how_to_store).trim() : null,
    allergens: item.allergens ? String(item.allergens).trim() : null,
    bundle_components: components,
    meta: Object.keys(metaBase).length ? metaBase : {},
    image_url_2: normalizePublicImageUrl(item.image_url_2) || null,
    image_url_3: normalizePublicImageUrl(item.image_url_3) || null,
    image_url_4: normalizePublicImageUrl(item.image_url_4) || null,
    image_url_5: normalizePublicImageUrl(item.image_url_5) || null,
    low_stock_alert_units: (() => {
      if (item.low_stock_alert_units == null || item.low_stock_alert_units === '') {
        return packagedLob ? 5 : null;
      }
      const n = parseInt(item.low_stock_alert_units, 10);
      return Number.isFinite(n) && n >= 0 ? n : (packagedLob ? 5 : null);
    })(),
    // Retail
    condition: item.condition ? String(item.condition).trim() : null,
    original_mrp: item.original_mrp != null && item.original_mrp !== ''
      ? parseFloat(item.original_mrp) || null
      : null,
    warranty_days: item.warranty_days != null && item.warranty_days !== ''
      ? parseInt(item.warranty_days, 10) || null
      : null,
    colour: item.colour || item.color ? String(item.colour || item.color).trim() : null,
    // PSL
    flavour_group: item.flavour_group ? String(item.flavour_group).trim() : null,
    scoop_count: item.scoop_count != null && item.scoop_count !== ''
      ? Math.max(1, parseInt(item.scoop_count, 10) || 1)
      : null,
    crust_options: item.crust_options ? String(item.crust_options).trim() : null,
    // NOT NULL in DB — never send null (food_products / retail omit this field)
    toppings_allowed: item.toppings_allowed != null
      ? parseBoolCell(item.toppings_allowed, false)
      : false,
    topping_extra_price: item.topping_extra_price != null && item.topping_extra_price !== ''
      ? parseFloat(item.topping_extra_price) || null
      : null,
    // Restaurant kitchen timing (also accepted for any LOB if sent)
    prep_time_fixed: item.prep_time_fixed != null && item.prep_time_fixed !== ''
      ? Math.max(0, parseInt(item.prep_time_fixed, 10) || 0)
      : undefined,
    batch_size: item.batch_size != null && item.batch_size !== ''
      ? Math.max(1, parseInt(item.batch_size, 10) || 1)
      : undefined,
    time_per_batch: item.time_per_batch != null && item.time_per_batch !== ''
      ? Math.max(1, parseInt(item.time_per_batch, 10) || 1)
      : undefined,
    packing_time: item.packing_time != null && item.packing_time !== ''
      ? Math.max(0, parseFloat(item.packing_time) || 0)
      : undefined,
    holds_well: item.holds_well != null && item.holds_well !== ''
      ? parseBoolCell(item.holds_well, false)
      : undefined,
    fulfillment_section: item.fulfillment_section != null && String(item.fulfillment_section).trim() !== ''
      ? String(item.fulfillment_section).trim()
      : undefined,
  };

  // Drop undefined kitchen fields so updates don't wipe existing values when omitted.
  for (const key of [
    'prep_time_fixed', 'batch_size', 'time_per_batch', 'packing_time',
    'holds_well', 'fulfillment_section', 'scoop_count', 'toppings_allowed',
  ]) {
    if (row[key] === undefined) delete row[key];
  }

  void lobType;
  return { row, errors, name, price: row.price, pack, components };
}

async function writeMenuItemRow(kind, targetId, restaurantId, row) {
  // Harden NOT NULL bools — callers may omit LOB-specific fields.
  if (row && row.toppings_allowed == null) row.toppings_allowed = false;

  // Resolve viewer/share image links (Kommodo etc.) to direct <img src> URLs before save.
  try {
    const { resolveMenuItemImageFields } = require('../../helpers/publicImageUrl');
    const resolved = await resolveMenuItemImageFields(row);
    Object.assign(row, {
      image_url: resolved.image_url,
      image_url_2: resolved.image_url_2,
      image_url_3: resolved.image_url_3,
      image_url_4: resolved.image_url_4,
      image_url_5: resolved.image_url_5,
    });
  } catch (e) {
    console.warn('[menu-items] image resolve skipped:', e.message);
  }

  async function run(payload) {
    if (kind === 'update') {
      return supabaseAdmin.from('menu_items').update(payload)
        .eq('id', targetId).eq('restaurant_id', restaurantId).select('*').single();
    }
    return supabaseAdmin.from('menu_items').insert(payload).select('*').single();
  }

  let { data, error } = await run(row);
  if (error && /menu_items\.meta|['"]meta['"] column|column ['"]?meta/i.test(error.message || '')) {
    const withoutMeta = { ...row };
    delete withoutMeta.meta;
    ({ data, error } = await run(withoutMeta));
  }
  if (error && /bundle_components/i.test(error.message || '')) {
    const withoutBundle = { ...row };
    delete withoutBundle.bundle_components;
    if (withoutBundle.meta && typeof withoutBundle.meta === 'object') {
      const meta = { ...withoutBundle.meta };
      delete meta.bundle_components;
      withoutBundle.meta = meta;
    }
    ({ data, error } = await run(withoutBundle));
  }
  if (error && /how_to_use/i.test(error.message || '')) {
    const withoutHowTo = { ...row };
    delete withoutHowTo.how_to_use;
    ({ data, error } = await run(withoutHowTo));
  }
  if (error && /how_to_store/i.test(error.message || '')) {
    const withoutHowToStore = { ...row };
    delete withoutHowToStore.how_to_store;
    ({ data, error } = await run(withoutHowToStore));
  }
  return { data, error };
}

async function handleMenuItemCreate(req, res) {
  try {
    const denied = await assertMenuCatalogEditPermission(req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const restaurantId = req.restaurant_id;
    const { data: tenantRow } = await supabaseAdmin
      .from('tenants')
      .select('lob_type, fssai_license')
      .eq('id', restaurantId)
      .maybeSingle();
    const lobType = String(tenantRow?.lob_type || '').toLowerCase();
    const packagedLob = ['food_products', 'retail', 'b2b', 'psl', 'jewellery', 'supply', 'b2b_supply'].includes(lobType);
    const blockNoFssai = lobType === 'food_products'
      && !String(tenantRow?.fssai_license || '').trim();

    const { row, errors, pack } = normalizeMenuItemBody(req.body || {}, { packagedLob, lobType });
    if (errors.length) return res.status(400).json({ error: errors[0], errors });

    const { data: existingRows } = await supabaseAdmin
      .from('menu_items')
      .select('retailer_id')
      .eq('restaurant_id', restaurantId);
    const existingIds = (existingRows || []).map((r) => r.retailer_id).filter(Boolean);

    let retailerId = String(req.body.retailer_id || req.body.id || '').trim();
    if (retailerId) {
      const clash = existingIds.some((id) => String(id).toUpperCase() === retailerId.toUpperCase());
      if (clash) {
        return res.status(400).json({ error: `SKU "${retailerId}" already exists` });
      }
    } else {
      retailerId = deriveRetailerId({
        name: row.name,
        packSizeLabel: pack,
        existingIds,
      });
    }

    const wantAvailable = req.body.is_available === undefined
      ? true
      : parseBoolCell(req.body.is_available, true);
    let stockQty = null;
    if (req.body.current_stock != null && req.body.current_stock !== '') {
      stockQty = Math.max(0, parseInt(req.body.current_stock, 10) || 0);
    }
    let isStocked = wantAvailable;
    if (stockQty === 0) isStocked = false;
    if (blockNoFssai) isStocked = false;
    if (row.availability_status === 'sold_out' || row.availability_status === 'coming_soon') {
      isStocked = false;
    }

    const now = new Date().toISOString();
    const insertRow = {
      ...row,
      restaurant_id: restaurantId,
      retailer_id: retailerId,
      is_stocked: isStocked,
      is_available: isStocked,
      current_stock: stockQty,
      kitchen_station: resolveKitchenStation(req.body.kitchen_station || '', {
        category: row.category,
        packagedLob,
      }),
      prep_time_fixed: row.prep_time_fixed != null
        ? row.prep_time_fixed
        : Math.max(0, parseInt(req.body.prep_time_fixed, 10) || 5),
      batch_size: row.batch_size != null
        ? row.batch_size
        : Math.max(1, parseInt(req.body.batch_size, 10) || 1),
      time_per_batch: row.time_per_batch != null
        ? row.time_per_batch
        : Math.max(1, parseInt(req.body.time_per_batch, 10) || 10),
      packing_time: row.packing_time != null
        ? row.packing_time
        : Math.max(0, parseFloat(req.body.packing_time) || 1),
      holds_well: row.holds_well != null
        ? row.holds_well
        : parseBoolCell(req.body.holds_well, false),
      fulfillment_section: row.fulfillment_section
        || String(req.body.fulfillment_section || 'main').trim()
        || 'main',
      archived_at: null,
      created_at: now,
      updated_at: now,
    };
    if (!insertRow.availability_status) {
      insertRow.availability_status = isStocked ? 'in_stock' : (stockQty === 0 ? 'sold_out' : null);
    }

    const { data, error } = await writeMenuItemRow('insert', null, restaurantId, insertRow);
    if (error) throw error;

    await writeAuditLog({
      user_id: req.user.sub,
      restaurant_id: restaurantId,
      action: 'Menu item created',
      details: { item_id: data.id, retailer_id: data.retailer_id, name: data.name },
    });

    const warnings = [];
    if (blockNoFssai) {
      warnings.push(
        'No FSSAI license on file — item was saved as out-of-stock. Add FSSAI in Settings before publishing.',
      );
    }

    res.json({ success: true, item: data, warnings: warnings.length ? warnings : undefined });

    bustWebcartMenuCache(restaurantId);

    if (data.retailer_id) {
      pushSingleItemToMetaCatalog({
        retailerId: data.retailer_id,
        isAvailable: !!data.is_available,
        restaurantId,
      }).catch((e) => console.error(`[menu-item-create-meta] ${data.name}:`, e.message));
    }
  } catch (err) {
    console.error('[menu-item-create]', err.message);
    res.status(400).json({ error: err.message });
  }
}

async function handleMenuItemUpdate(req, res) {
  try {
    const denied = await assertMenuCatalogEditPermission(req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const restaurantId = req.restaurant_id;
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('menu_items')
      .select('*')
      .eq('id', req.params.id)
      .eq('restaurant_id', restaurantId)
      .is('archived_at', null)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ error: 'Menu item not found' });

    const { data: tenantRow } = await supabaseAdmin
      .from('tenants')
      .select('lob_type, fssai_license')
      .eq('id', restaurantId)
      .maybeSingle();
    const lobType = String(tenantRow?.lob_type || '').toLowerCase();
    const packagedLob = ['food_products', 'retail', 'b2b', 'psl', 'jewellery', 'supply', 'b2b_supply'].includes(lobType);
    const blockNoFssai = lobType === 'food_products'
      && !String(tenantRow?.fssai_license || '').trim();

    const { row, errors } = normalizeMenuItemBody(req.body || {}, {
      packagedLob,
      existingMeta: existing.meta,
      lobType,
    });
    if (errors.length) return res.status(400).json({ error: errors[0], errors });

    // Keep retailer_id stable — never steal another SKU's id on update.
    const requestedSku = String(req.body.retailer_id || req.body.id || '').trim();
    if (requestedSku
      && requestedSku.toUpperCase() !== String(existing.retailer_id || '').toUpperCase()) {
      const { data: clash } = await supabaseAdmin
        .from('menu_items')
        .select('id')
        .eq('restaurant_id', restaurantId)
        .ilike('retailer_id', requestedSku)
        .neq('id', existing.id)
        .limit(1)
        .maybeSingle();
      if (clash) {
        return res.status(400).json({ error: `SKU "${requestedSku}" is already used by another item` });
      }
    }

    const patch = {
      ...row,
      updated_at: new Date().toISOString(),
    };
    // Do not overwrite stock on edit unless client opts in.
    delete patch.current_stock;
    if (req.body.update_stock === true && req.body.current_stock != null && req.body.current_stock !== '') {
      patch.current_stock = Math.max(0, parseInt(req.body.current_stock, 10) || 0);
    }

    if (requestedSku) patch.retailer_id = requestedSku;
    else patch.retailer_id = existing.retailer_id;

    if (req.body.is_available !== undefined) {
      let isStocked = parseBoolCell(req.body.is_available, true);
      if (blockNoFssai && isStocked) isStocked = false;
      const stockRef = patch.current_stock !== undefined
        ? patch.current_stock
        : existing.current_stock;
      if (packagedLob && stockRef != null && Number(stockRef) <= 0) isStocked = false;
      patch.is_stocked = isStocked;
      patch.is_available = isStocked;
      if (!patch.availability_status) {
        patch.availability_status = isStocked ? 'in_stock' : 'sold_out';
      }
    } else if (blockNoFssai) {
      // Don't force OOS on every edit if they weren't toggling availability —
      // leave existing flags unless FSSAI missing and they're trying coming_soon→live via status.
      if (patch.availability_status === 'in_stock') {
        patch.is_stocked = false;
        patch.is_available = false;
        patch.availability_status = 'sold_out';
      }
    }

    if (req.body.kitchen_station != null && String(req.body.kitchen_station).trim() !== '') {
      patch.kitchen_station = resolveKitchenStation(req.body.kitchen_station, {
        category: patch.category,
        packagedLob,
      });
    }

    const { data, error } = await writeMenuItemRow('update', existing.id, restaurantId, patch);
    if (error) throw error;

    await writeAuditLog({
      user_id: req.user.sub,
      restaurant_id: restaurantId,
      action: 'Menu item updated',
      details: { item_id: data.id, retailer_id: data.retailer_id, name: data.name },
    });

    const warnings = [];
    if (blockNoFssai) {
      warnings.push(
        'No FSSAI license on file — stock publishing stays blocked until you add FSSAI in Settings.',
      );
    }

    res.json({ success: true, item: data, warnings: warnings.length ? warnings : undefined });

    bustWebcartMenuCache(restaurantId);

    if (data.retailer_id) {
      pushSingleItemToMetaCatalog({
        retailerId: data.retailer_id,
        isAvailable: !!data.is_available,
        restaurantId,
      }).catch((e) => console.error(`[menu-item-update-meta] ${data.name}:`, e.message));
    }
  } catch (err) {
    console.error('[menu-item-update]', err.message);
    res.status(400).json({ error: err.message });
  }
}

async function handleMenuItemDelete(req, res) {
  try {
    const denied = await assertMenuCatalogEditPermission(req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const restaurantId = req.restaurant_id;
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('menu_items')
      .select('id, name, retailer_id, archived_at')
      .eq('id', req.params.id)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ error: 'Menu item not found' });
    if (existing.archived_at) {
      return res.json({ success: true, id: existing.id, already_archived: true });
    }

    const now = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from('menu_items')
      .update({
        archived_at: now,
        is_available: false,
        is_stocked: false,
        updated_at: now,
      })
      .eq('id', existing.id)
      .eq('restaurant_id', restaurantId);
    if (error) throw error;

    await writeAuditLog({
      user_id: req.user.sub,
      restaurant_id: restaurantId,
      action: 'Menu item archived',
      details: { item_id: existing.id, retailer_id: existing.retailer_id, name: existing.name },
    });

    res.json({ success: true, id: existing.id, archived: true });

    bustWebcartMenuCache(restaurantId);

    if (existing.retailer_id) {
      pushSingleItemToMetaCatalog({
        retailerId: existing.retailer_id,
        isAvailable: false,
        restaurantId,
      }).catch((e) => console.error(`[menu-item-delete-meta] ${existing.name}:`, e.message));
    }
  } catch (err) {
    console.error('[menu-item-delete]', err.message);
    res.status(400).json({ error: err.message });
  }
}

const menuItemCreateMiddleware = [authenticateToken, getRestaurantId, handleMenuItemCreate];
const menuItemUpdateMiddleware = [authenticateToken, getRestaurantId, handleMenuItemUpdate];
const menuItemDeleteMiddleware = [authenticateToken, getRestaurantId, handleMenuItemDelete];
router.post('/menu-items', ...menuItemCreateMiddleware);
router.put('/menu-items/:id', ...menuItemUpdateMiddleware);
router.delete('/menu-items/:id', ...menuItemDeleteMiddleware);

module.exports = router;
module.exports.handleMenuUpload = handleMenuUpload;
module.exports.menuUploadMiddleware = menuUploadMiddleware;
module.exports.menuItemAvailabilityMiddleware = menuItemAvailabilityMiddleware;
module.exports.menuItemMarkAllStockedMiddleware = menuItemMarkAllStockedMiddleware;
module.exports.menuItemRestockMiddleware = menuItemRestockMiddleware;
module.exports.menuItemBulkRestockMiddleware = menuItemBulkRestockMiddleware;
module.exports.menuItemLaunchMiddleware = menuItemLaunchMiddleware;
module.exports.menuItemSpecialTodayMiddleware = menuItemSpecialTodayMiddleware;
module.exports.menuItemDiscountMiddleware = menuItemDiscountMiddleware;
module.exports.menuItemStockAlertsMiddleware = menuItemStockAlertsMiddleware;
module.exports.menuItemCreateMiddleware = menuItemCreateMiddleware;
module.exports.menuItemUpdateMiddleware = menuItemUpdateMiddleware;
module.exports.menuItemDeleteMiddleware = menuItemDeleteMiddleware;
module.exports.resetDailySpecialDishes = resetDailySpecialDishes;
