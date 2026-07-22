'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin } = require('../../config/supabase');
const { authenticateToken, getRestaurantId } = require('../../middleware/auth');
const { writeAuditLog } = require('../../helpers/auditLog');
const {
  SLOTS,
  getCurrentSlotIST,
  SLOT_DISPLAY_LABELS,
  MANUAL_KITCHEN_OPEN_OVERRIDES,
  nextOpenLabelIST,
  applySlotAvailability,
} = require('./shared/slots');
const { syncCatalogFromMeta } = require('./shared/meta');

// ── POST /api/catalog/sync ────────────────────────────────────────────────────

router.post('/sync', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });
    const result = await syncCatalogFromMeta(req.restaurant_id);
    if (result.success) {
      await writeAuditLog({
        user_id: req.user.sub,
        restaurant_id: req.restaurant_id,
        action: 'Meta catalog sync',
        details: { synced: result.synced, skipped: result.skipped, total: result.total },
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/catalog/status — last menu sync snapshot ─────────────────────────

router.get('/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const restaurantId = req.restaurant_id;
    const [{ data: latestItem }, { count: itemCount }, { data: auditRows }] = await Promise.all([
      supabaseAdmin.from('menu_items')
        .select('updated_at, meta_product_id')
        .eq('restaurant_id', restaurantId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin.from('menu_items')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantId),
      supabaseAdmin.from('audit_logs')
        .select('created_at, details')
        .eq('restaurant_id', restaurantId)
        .eq('action', 'Meta catalog sync')
        .order('created_at', { ascending: false })
        .limit(1),
    ]);

    const lastMetaSync = auditRows?.[0]?.created_at || null;
    const lastSync = lastMetaSync || latestItem?.updated_at || null;

    res.json({
      success: true,
      lastSync,
      lastMetaSync,
      itemCount: itemCount ?? 0,
      hasMetaLinkedItems: Boolean(latestItem?.meta_product_id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/catalog/webhook — Meta verification ──────────────────────────────

router.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Meta catalog webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).json({ error: 'Forbidden' });
});

// ── POST /api/catalog/webhook — catalog change events ────────────────────────

router.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  try {
    if (req.body.object !== 'product_catalog') return;
    const { data: restaurants } = await supabaseAdmin.from('tenants').select('id').eq('is_active', true);
    for (const r of restaurants ?? [])
      syncCatalogFromMeta(r.id).catch(err => console.error(`[catalog-webhook] Sync failed for ${r.id}:`, err.message));
  } catch (err) {
    console.error('[catalog-webhook] Handler error:', err.message);
  }
});

// ── GET /api/catalog/kitchen-status — Manager portal kitchen open/closed ─────

router.get('/kitchen-status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const currentSlot = getCurrentSlotIST();
    const [itemsResult, restResult] = await Promise.all([
      supabaseAdmin.from('menu_items')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', req.restaurant_id)
        .eq('is_available', true)
        .eq('is_stocked', true),
      supabaseAdmin.from('tenants')
        .select('kitchen_busy, takeaway_ready_range, delivery_ready_range')
        .eq('id', req.restaurant_id)
        .maybeSingle(),
    ]);
    if (itemsResult.error) throw itemsResult.error;
    if (restResult.error) throw restResult.error;
    const rest = restResult.data;
    const count = itemsResult.count;

    res.json({
      success: true,
      is_open: (count ?? 0) > 0,
      available_items: count ?? 0,
      kitchen_busy: !!rest?.kitchen_busy,
      takeaway_ready_range: rest?.takeaway_ready_range ?? null,
      delivery_ready_range: rest?.delivery_ready_range ?? null,
      current_slot: currentSlot,
      current_slot_label: currentSlot ? SLOT_DISPLAY_LABELS[currentSlot] : null,
      schedule_open: currentSlot != null,
      next_open_label: nextOpenLabelIST(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/catalog/kitchen-toggle — Manager open/close for WhatsApp orders ─

router.post('/kitchen-toggle', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const { open } = req.body;
    if (typeof open !== 'boolean')
      return res.status(400).json({ error: 'open (boolean) required' });

    const { onKitchenOpened, countAvailableMenuItems } = require('../../helpers/kitchenReminders');
    const wasOpen = (await countAvailableMenuItems(req.restaurant_id)) > 0;

    let result;
    if (open) {
      const slot = getCurrentSlotIST();
      if (slot) {
        MANUAL_KITCHEN_OPEN_OVERRIDES.delete(req.restaurant_id);
        result = await applySlotAvailability(req.restaurant_id, slot);
      } else {
        const { data, error } = await supabaseAdmin.from('menu_items')
          .update({ is_available: true, updated_at: new Date().toISOString() })
          .eq('restaurant_id', req.restaurant_id)
          .eq('is_stocked', true)
          .select('id');
        if (error) throw error;
        MANUAL_KITCHEN_OPEN_OVERRIDES.add(req.restaurant_id);
        result = { slot: 'manual', available: data?.length ?? 0 };
      }
    } else {
      MANUAL_KITCHEN_OPEN_OVERRIDES.delete(req.restaurant_id);
      result = await applySlotAvailability(req.restaurant_id, null);
    }

    if (open && !wasOpen) {
      onKitchenOpened(req.restaurant_id, { source: 'manager-toggle' }).catch(err =>
        console.error('[kitchen-remind] manager-toggle notify failed:', err.message),
      );
    }

    res.json({ success: true, is_open: open, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/catalog/kitchen-busy-toggle — Manager rush-hour flag ───────────

router.post('/kitchen-busy-toggle', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const { busy } = req.body;
    if (typeof busy !== 'boolean')
      return res.status(400).json({ error: 'busy (boolean) required' });

    const { data, error } = await supabaseAdmin.from('tenants').update({
      kitchen_busy: busy,
      updated_at: new Date().toISOString(),
    }).eq('id', req.restaurant_id).select('kitchen_busy').single();

    if (error) throw error;

    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: busy ? 'Kitchen marked busy' : 'Kitchen marked normal',
      details: { kitchen_busy: busy },
    });

    res.json({ success: true, kitchen_busy: data.kitchen_busy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/catalog/slot-sync — Manual slot override ───────────────────────

router.post('/slot-sync', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role))
      return res.status(403).json({ error: 'Unauthorized' });

    const slot       = req.body.slot ?? getCurrentSlotIST();
    const validSlots = [...SLOTS.map(s => s.dbValue), null];
    if (req.body.slot !== undefined && !validSlots.includes(req.body.slot))
      return res.status(400).json({ error: `Invalid slot. Must be one of: ${SLOTS.map(s => s.dbValue).join(', ')}` });

    const { onKitchenOpened, countAvailableMenuItems } = require('../../helpers/kitchenReminders');
    const wasOpen = (await countAvailableMenuItems(req.restaurant_id)) > 0;
    const result = await applySlotAvailability(req.restaurant_id, slot);
    MANUAL_KITCHEN_OPEN_OVERRIDES.delete(req.restaurant_id);
    if (slot && !wasOpen) {
      onKitchenOpened(req.restaurant_id, { source: 'slot-sync' }).catch(err =>
        console.error('[kitchen-remind] slot-sync notify failed:', err.message),
      );
    }
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/catalog/feed — CSV product feed for Meta ────────────────────────

module.exports = router;
