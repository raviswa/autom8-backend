// src/routes/pos.js
// Handles: menu items, orders, KOT tickets, KDS items, tables, payments, reports
// Extracted from server.js — no logic changes, just moved here.

const express = require('express');
const router  = express.Router();
const { supabaseAdmin }           = require('../config/supabase');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');
const { broadcastToRestaurant }   = require('../websocket');
const { sendWhatsAppMessage, sendWhatsAppCatalogMessage } = require('../helpers/whatsapp');
const { applySlotAvailability, getCurrentSlotIST } = require('./catalog');
const { notifyOrderReady }        = require('../helpers/whatsapp');

// ── Menu items ───────────────────────────────────────────────────────────────

router.get('/menu-items', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { category, ignore_slot } = req.query;
    const isManagerView = ignore_slot === 'true';

    const now        = new Date();
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const istMinutes = (utcMinutes + 330) % (24 * 60);
    const istHour    = Math.floor(istMinutes / 60);
    let currentSlot;
    if      (istHour >= 6  && istHour < 11) currentSlot = 'morning_tiffin';
    else if (istHour >= 11 && istHour < 15) currentSlot = 'lunch';
    else if (istHour >= 15 && istHour < 19) currentSlot = 'evening_snacks';
    else if (istHour >= 19 && istHour < 23) currentSlot = 'dinner_tiffin';
    else                                    currentSlot = null;

    let query = supabaseAdmin.from('menu_items').select('*')
      .eq('restaurant_id', req.restaurant_id)
      .order('time_slot', { ascending: true })
      .order('name',      { ascending: true });

    if (category) query = query.eq('category', category);

    if (isManagerView) {
      query = query.order('is_stocked', { ascending: false });
    } else {
      query = query.eq('is_available', true);
      if (currentSlot) query = query.or(`time_slot.eq.${currentSlot},time_slot.eq.all`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, count: data.length, items: data, current_slot: currentSlot, ist_hour: istHour });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/menu-items', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner')
      return res.status(403).json({ error: 'Unauthorized' });
    const { name, description, price, category } = req.body;
    const { data, error } = await supabaseAdmin.from('menu_items')
      .insert({ restaurant_id: req.restaurant_id, name, description, price, category, is_available: true })
      .select().single();
    if (error) throw error;
    res.json({ success: true, item: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// ── Orders ───────────────────────────────────────────────────────────────────

router.get('/orders', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    let query = supabaseAdmin.from('orders')
      .select(`*, table:table_id(table_number, section), order_items(*, menu_item:menu_item_id(name, category))`)
      .eq('restaurant_id', req.restaurant_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, orders: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/orders/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('orders')
      .select(`*, table:table_id(table_number, section), order_items(*, menu_item:menu_item_id(name, category, price)), payments(*)`)
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id).single();
    if (error) throw error;
    res.json({ success: true, order: data });
  } catch (err) {
    res.status(404).json({ error: 'Order not found' });
  }
});

router.post('/orders', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner')
      return res.status(403).json({ error: 'Unauthorized' });

    const { table_id, items, notes } = req.body;
    const orderNumber = `ORD-${Date.now()}`;

    const { data: orderData, error: orderError } = await supabaseAdmin.from('orders')
      .insert({ restaurant_id: req.restaurant_id, table_id, order_number: orderNumber, notes, created_by: req.user.sub })
      .select().single();
    if (orderError) throw orderError;

    let subtotal   = 0;
    const orderItems = [];
    for (const item of items) {
      const { data: menuItem } = await supabaseAdmin.from('menu_items')
        .select('price').eq('id', item.menu_item_id).single();
      subtotal += menuItem.price * item.quantity;
      const { data: itemData, error: itemError } = await supabaseAdmin.from('order_items')
        .insert({ order_id: orderData.id, menu_item_id: item.menu_item_id, quantity: item.quantity,
          unit_price: menuItem.price, special_instructions: item.special_instructions })
        .select().single();
      if (itemError) throw itemError;
      orderItems.push(itemData);
      await supabaseAdmin.from('kds_items').insert({
        restaurant_id: req.restaurant_id, order_item_id: itemData.id, status: 'pending',
      });
    }

    const tax = subtotal * 0.1, total = subtotal + tax;
    await supabaseAdmin.from('orders').update({ subtotal, tax, total_amount: total }).eq('id', orderData.id);
    if (table_id) await supabaseAdmin.from('tables').update({ status: 'occupied' }).eq('id', table_id);

    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id: req.user.sub, restaurant_id: req.restaurant_id,
        action: 'Order created', details: { order_id: orderData.id, order_number: orderNumber },
      });
    } catch (_) {}

    res.json({ success: true, order: { ...orderData, subtotal, tax, total_amount: total, order_items: orderItems } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/orders/:id/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabaseAdmin.from('orders')
      .update({ status }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;
    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id: req.user.sub, restaurant_id: req.restaurant_id,
        action: 'Order status updated', details: { order_id: req.params.id, status },
      });
    } catch (_) {}
    res.json({ success: true, order: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/orders/:id/complete', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const orderId = req.params.id;

    const { data: order, error: orderFetchError } = await supabaseAdmin.from('orders')
      .select(`id, order_number, status, restaurant_id, table:table_id!left(table_number), walk_in_tokens(phone)`)
      .eq('id', orderId).eq('restaurant_id', req.restaurant_id).single();
    if (orderFetchError || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'completed' || order.status === 'cancelled')
      return res.status(400).json({ error: `Order is already ${order.status}` });

    const { data: kdsItems, error: kdsFetchError } = await supabaseAdmin.from('kds_items')
      .select('id, status, order_item:order_item_id!left(order_id), customer_phone, token_number')
      .eq('restaurant_id', req.restaurant_id);
    if (kdsFetchError) throw kdsFetchError;

    const orderKdsItems = (kdsItems ?? []).filter(i => i.order_item?.order_id === orderId);
    if (orderKdsItems.length === 0) return res.status(404).json({ error: 'No KDS items found for this order' });

    const activeItems    = orderKdsItems.filter(i => i.status !== 'cancelled');
    const alreadyAllDone = activeItems.every(i => i.status === 'ready');

    if (!alreadyAllDone) {
      const { error: bulkUpdateError } = await supabaseAdmin.from('kds_items')
        .update({ status: 'ready' })
        .in('id', activeItems.map(i => i.id))
        .eq('restaurant_id', req.restaurant_id);
      if (bulkUpdateError) throw bulkUpdateError;
    }

    const firstKdsItem = orderKdsItems.find(i => i.customer_phone) ?? orderKdsItems[0];
    await notifyOrderReady({ orderId, restaurantId: req.restaurant_id, kdsItem: firstKdsItem });

    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id: req.user.sub, restaurant_id: req.restaurant_id,
        action: 'Order marked ready via /complete',
        details: { order_id: orderId, order_number: order.order_number, kds_items_updated: alreadyAllDone ? 0 : activeItems.length },
      });
    } catch (_) {}

    res.json({ success: true, order_id: orderId, order_number: order.order_number, kds_items_updated: alreadyAllDone ? 0 : activeItems.length });
  } catch (err) {
    console.error('[POST /api/orders/:id/complete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/orders/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner')
      return res.status(403).json({ error: 'Unauthorized' });

    const { data, error } = await supabaseAdmin.from('orders')
      .update({ status: 'cancelled' }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;

    if (data.table_id) {
      const { data: activeOrders } = await supabaseAdmin.from('orders').select('id')
        .eq('table_id', data.table_id).in('status', ['pending', 'confirmed', 'in_progress']);
      if (!activeOrders || activeOrders.length === 0)
        await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', data.table_id);
    }

    try {
      await supabaseAdmin.from('audit_logs').insert({
        user_id: req.user.sub, restaurant_id: req.restaurant_id,
        action: 'Order cancelled', details: { order_id: req.params.id },
      });
    } catch (_) {}

    res.json({ success: true, order: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── KDS ──────────────────────────────────────────────────────────────────────

router.get('/kds/feed', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const statusFilter = status === 'all' ? ['pending', 'in_progress', 'ready'] : [status];
    const { data, error } = await supabaseAdmin.from('kds_items')
      .select(`*, order_item:order_item_id!left(*, menu_item:menu_item_id!left(name, description, prep_time_minutes), order:order_id!left(table:table_id!left(table_number, section), order_number))`)
      .eq('restaurant_id', req.restaurant_id)
      .in('status', statusFilter)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, items: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/kds/:id/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabaseAdmin.from('kds_items')
      .update({ status }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;

    if (status === 'ready') {
      try {
        const { data: kdsItem } = await supabaseAdmin.from('kds_items')
          .select('order_item:order_item_id!left(order_id), token_number, customer_phone, service_type')
          .eq('id', req.params.id).single();

        const orderId = kdsItem?.order_item?.order_id;
        if (orderId) {
          const { data: allItems } = await supabaseAdmin.from('kds_items')
            .select('status, order_item:order_item_id!left(order_id)')
            .eq('restaurant_id', req.restaurant_id);
          const orderItems = (allItems ?? []).filter(i => i.order_item?.order_id === orderId);
          const allReady   = orderItems.length > 0 && orderItems.every(i => i.status === 'ready');
          if (allReady) await notifyOrderReady({ orderId, restaurantId: req.restaurant_id, kdsItem });
        }
      } catch (notifyErr) {
        console.error('[KDS ready notify] Failed:', notifyErr.message);
      }
    }

    res.json({ success: true, item: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Tables ───────────────────────────────────────────────────────────────────

router.get('/tables', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('tables').select('*')
      .eq('restaurant_id', req.restaurant_id).order('table_number', { ascending: true });
    if (error) throw error;
    res.json({ success: true, tables: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/tables/:id/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabaseAdmin.from('tables')
      .update({ status }).eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;

    if (status === 'available') {
      try {
        const { data: recentToken } = await supabaseAdmin.from('walk_in_tokens')
          .select('phone, name, id as token_number, restaurant_id')
          .eq('table_id', req.params.id).eq('status', 'seated')
          .order('seated_at', { ascending: false }).limit(1).maybeSingle();
        if (recentToken?.phone) {
          await supabaseAdmin.from('feedback_pending').insert({ restaurant_id: recentToken.restaurant_id, customer_phone: String(recentToken.phone).replace(/\D/g, ''), customer_name: recentToken.name || 'Guest', token_number: recentToken.token_number, table_number: data.table_number, freed_at: new Date().toISOString() });
          console.log(`[table-freed] Queued feedback for ${recentToken.phone}`);
        }
      } catch (feedbackQueueErr) {
        console.error('[table-freed] Failed to queue feedback:', feedbackQueueErr.message);
      }
    }

    res.json({ success: true, table: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/tables', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    const { table_number, capacity = 4, section = null } = req.body;
    if (!table_number) return res.status(400).json({ error: 'table_number is required' });
    const { data, error } = await supabaseAdmin
      .from('tables')
      .insert({ restaurant_id: req.restaurant_id, table_number: parseInt(table_number), capacity: parseInt(capacity), section, status: 'available', is_active: true })
      .select().single();
    if (error) throw error;
    res.status(201).json({ success: true, table: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/tables/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    const { table_number, capacity, section, is_active } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (table_number !== undefined) updates.table_number = parseInt(table_number);
    if (capacity     !== undefined) updates.capacity     = parseInt(capacity);
    if (section      !== undefined) updates.section      = section;
    if (is_active    !== undefined) updates.is_active    = Boolean(is_active);
    const { data, error } = await supabaseAdmin
      .from('tables')
      .update(updates)
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id)
      .select().single();
    if (error) throw error;
    res.json({ success: true, table: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/tables/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    // Block delete if table is currently occupied
    const { data: table } = await supabaseAdmin
      .from('tables').select('status, table_number').eq('id', req.params.id).single();
    if (table?.status === 'occupied')
      return res.status(409).json({ error: `Table ${table.table_number} is currently occupied — free it before deleting` });
    const { error } = await supabaseAdmin
      .from('tables')
      .delete()
      .eq('id', req.params.id).eq('restaurant_id', req.restaurant_id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Owner self-service restaurant update ──────────────────────────────────────
// Used by SettingsPanel tabs: Restaurant, Services, Kitchen, WhatsApp

router.put('/restaurants/me', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });

    const ALLOWED = [
      'name','display_name','legal_name','address_line1','address_line2',
      'city','state','postal_code','country',
      'contact_phone','contact_email','website_url','cuisine_type',
      'logo_url','gstin','opening_hours',
      'whatsapp_number','waba_id','manager_phone',
      'timezone','dining_duration_minutes','payment_mode','kitchen_workflow',
      'subscribed_features',
    ];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => ALLOWED.includes(k))
    );
    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: 'No valid fields provided' });

    updates.updated_at = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('restaurants')
      .update(updates)
      .eq('id', req.restaurant_id)
      .select().single();
    if (error) throw error;

    await supabaseAdmin.from('audit_logs').insert({
      user_id: req.user.id, restaurant_id: req.restaurant_id,
      action: 'Restaurant settings updated', details: { fields: Object.keys(updates) },
    }).catch(() => {});

    res.json({ success: true, restaurant: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── WhatsApp integration credentials ──────────────────────────────────────────
router.get('/restaurants/integration', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('restaurant_integrations')
      .select('id,provider,channel,phone_number_id,access_token,webhook_secret,webhook_verify_token,config,is_active')
      .eq('restaurant_id', req.restaurant_id)
      .eq('provider', 'meta').eq('channel', 'whatsapp')
      .maybeSingle();
    res.json({ success: true, integration: data ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/restaurants/integration', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });

    const { provider = 'meta', channel = 'whatsapp', phone_number_id, access_token, webhook_secret, webhook_verify_token } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (phone_number_id     !== undefined) updates.phone_number_id     = phone_number_id;
    if (access_token        !== undefined) updates.access_token        = access_token;
    if (webhook_secret      !== undefined) updates.webhook_secret      = webhook_secret;
    if (webhook_verify_token!== undefined) updates.webhook_verify_token= webhook_verify_token;

    const { data: existing } = await supabaseAdmin
      .from('restaurant_integrations')
      .select('id').eq('restaurant_id', req.restaurant_id)
      .eq('provider', provider).eq('channel', channel).maybeSingle();

    let result;
    if (existing) {
      const { data, error } = await supabaseAdmin
        .from('restaurant_integrations').update(updates)
        .eq('id', existing.id).select().single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('restaurant_integrations')
        .insert({ restaurant_id: req.restaurant_id, provider, channel, is_active: true, ...updates })
        .select().single();
      if (error) throw error;
      result = data;
    }
    res.json({ success: true, integration: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Payments ─────────────────────────────────────────────────────────────────

router.post('/payments', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'manager' && req.user_role !== 'owner')
      return res.status(403).json({ error: 'Unauthorized' });

    const { order_id, amount, payment_method } = req.body;
    const { data, error } = await supabaseAdmin.from('payments')
      .insert({ restaurant_id: req.restaurant_id, order_id, amount, payment_method, status: 'completed', processed_by: req.user.sub })
      .select().single();
    if (error) throw error;

    await supabaseAdmin.from('orders').update({ payment_status: 'paid', status: 'completed' }).eq('id', order_id);
    const { data: order } = await supabaseAdmin.from('orders').select('table_id').eq('id', order_id).single();
    if (order.table_id) {
      await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', order.table_id);
      try {
        const { data: recentToken } = await supabaseAdmin.from('walk_in_tokens')
          .select('phone, name, id as token_number, restaurant_id')
          .eq('table_id', order.table_id).eq('status', 'seated')
          .order('seated_at', { ascending: false }).limit(1).maybeSingle();
        if (recentToken?.phone) {
          const { data: tableInfo } = await supabaseAdmin.from('tables').select('table_number').eq('id', order.table_id).single();
          await supabaseAdmin.from('feedback_pending').insert({ restaurant_id: req.restaurant_id, customer_phone: String(recentToken.phone).replace(/\D/g, ''), customer_name: recentToken.name || 'Guest', token_number: recentToken.token_number, table_number: tableInfo?.table_number, freed_at: new Date().toISOString() });
        }
      } catch (feedbackQueueErr) {
        console.error('[payment-complete] Failed to queue feedback:', feedbackQueueErr.message);
      }
    }

    try {
      await supabaseAdmin.from('audit_logs').insert({ user_id: req.user.sub, restaurant_id: req.restaurant_id, action: 'Payment processed', details: { order_id, amount, method: payment_method } });
    } catch (_) {}

    res.json({ success: true, payment: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Reports ──────────────────────────────────────────────────────────────────

router.get('/reports/sales', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (req.user_role !== 'owner' && req.user_role !== 'manager')
      return res.status(403).json({ error: 'Unauthorized' });
    const reportDate = req.query.date || new Date().toISOString().split('T')[0];
    const { data, error } = await supabaseAdmin.from('orders')
      .select('id, total_amount, status, created_at, order_items(menu_item:menu_item_id(category))')
      .eq('restaurant_id', req.restaurant_id)
      .gte('created_at', `${reportDate}T00:00:00`)
      .lt('created_at',  `${reportDate}T23:59:59`)
      .eq('status', 'completed');
    if (error) throw error;
    const totalRevenue  = data.reduce((sum, o) => sum + (o.total_amount || 0), 0);
    const totalOrders   = data.length;
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const categoryBreakdown = {};
    data.forEach(order => {
      order.order_items?.forEach(item => {
        const cat = item.menu_item?.category || 'Other';
        categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;
      });
    });
    res.json({ success: true, report: { date: reportDate, totalOrders, totalRevenue, avgOrderValue, categoryBreakdown } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
