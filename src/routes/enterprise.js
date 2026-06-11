// src/routes/enterprise.js
// ============================================================================
// Enterprise / Brand Analytics Dashboard
//
// POST /api/enterprise/dashboard
//   Role-gated brand/store analytics endpoint.
//   Enforces a strict Parent/Child brand_id → store_id hierarchy.
//
// Updated: accepts brand_owner and brand_manager roles (not 'corporate').
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabase, supabaseAdmin } = require('../config/supabase');

// ── enforceHierarchyAccess ────────────────────────────────────────────────────

async function enforceHierarchyAccess(userId, requestedScope, storeId = null) {
  const { data: userData } = await supabaseAdmin
    .from('employees')
    .select('role, restaurant_id, brand_id')
    .eq('id', userId)
    .single();

  if (!userData) return { allowed: false, reason: 'User not found' };
  const role = userData.role;

  if (requestedScope === 'brand') {
    const BRAND_ALLOWED = ['brand_owner', 'brand_manager', 'owner', 'corporate'];
    if (!BRAND_ALLOWED.includes(role))
      return { allowed: false, reason: 'Brand-level access requires brand_owner or brand_manager role' };

    const { data: allRestaurants } = await supabaseAdmin
      .from('restaurants').select('id, name')
      .eq('brand_id', userData.brand_id).eq('is_active', true);

    return {
      allowed:            true,
      role,
      brandId:            userData.brand_id,
      scopeRestaurantIds: (allRestaurants ?? []).map(r => r.id),
      restaurantMeta:     allRestaurants ?? [],
    };
  }

  if (requestedScope === 'store') {
    const STORE_FULL = ['owner', 'brand_owner', 'brand_manager', 'corporate'];
    if (role === 'manager' || role === 'store_manager') {
      if (storeId && storeId !== userData.restaurant_id)
        return { allowed: false, reason: 'Managers can only view their own branch' };
      return { allowed: true, role, scopeRestaurantIds: [userData.restaurant_id], restaurantMeta: [{ id: userData.restaurant_id }] };
    }
    if (STORE_FULL.includes(role)) {
      const targetId = storeId || userData.restaurant_id;
      return { allowed: true, role, scopeRestaurantIds: [targetId], restaurantMeta: [{ id: targetId }] };
    }
    return { allowed: false, reason: 'Insufficient role for store access' };
  }

  return { allowed: false, reason: 'Invalid requested_scope' };
}

// ── getRFMAtRiskCount ─────────────────────────────────────────────────────────

async function getRFMAtRiskCount(restaurantIds) {
  try {
    if (!restaurantIds?.length) return 0;
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const { data: atRisk } = await supabaseAdmin
      .from('orders').select('customer_phone')
      .in('restaurant_id', restaurantIds).eq('status', 'completed').lt('created_at', fourteenDaysAgo);
    const { data: recentOrders } = await supabaseAdmin
      .from('orders').select('customer_phone')
      .in('restaurant_id', restaurantIds).eq('status', 'completed').gte('created_at', fourteenDaysAgo);

    const atRiskSet  = new Set((atRisk       ?? []).map(r => r.customer_phone).filter(Boolean));
    const recentSet  = new Set((recentOrders ?? []).map(r => r.customer_phone).filter(Boolean));
    for (const p of recentSet) atRiskSet.delete(p);
    return atRiskSet.size;
  } catch (err) {
    console.error('[rfm-at-risk]', err.message);
    return 0;
  }
}

// ── POST /api/enterprise/dashboard ───────────────────────────────────────────

router.post('/dashboard', async (req, res) => {
  try {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(403).json({ error: 'Invalid token' });

    const { requested_scope = 'brand', store_id, date } = req.body;
    const reportDate = date || new Date().toISOString().split('T')[0];

    const access = await enforceHierarchyAccess(user.id, requested_scope, store_id);
    if (!access.allowed) return res.status(403).json({ error: access.reason });

    const { scopeRestaurantIds, restaurantMeta, role } = access;
    if (!scopeRestaurantIds.length) return res.status(404).json({ error: 'No restaurants found in scope' });

    const { data: orders } = await supabaseAdmin
      .from('orders').select('restaurant_id, total_amount, status, created_at')
      .in('restaurant_id', scopeRestaurantIds).eq('status', 'completed')
      .gte('created_at', `${reportDate}T00:00:00.000Z`)
      .lte('created_at', `${reportDate}T23:59:59.999Z`);

    const revenueByStore = {};
    let totalRevenue = 0;
    for (const order of orders ?? []) {
      revenueByStore[order.restaurant_id] = (revenueByStore[order.restaurant_id] ?? 0) + (order.total_amount ?? 0);
      totalRevenue += (order.total_amount ?? 0);
    }

    let topBranchId = null, topBranchRev = 0;
    for (const [rid, rev] of Object.entries(revenueByStore)) {
      if (rev > topBranchRev) { topBranchRev = rev; topBranchId = rid; }
    }
    const topBranchName = restaurantMeta.find(r => r.id === topBranchId)?.name ?? '—';

    const { data: topItems } = await supabaseAdmin
      .from('order_items')
      .select('quantity, menu_item:menu_item_id(name, restaurant_id)')
      .in('menu_item.restaurant_id', scopeRestaurantIds);

    const itemQty = {};
    for (const oi of topItems ?? []) {
      const name = oi.menu_item?.name || oi.menu_item_id;
      itemQty[name] = (itemQty[name] ?? 0) + (oi.quantity ?? 1);
    }
    const topItem = Object.entries(itemQty).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';

    const { count: overrideCount } = await supabaseAdmin
      .from('menu_items').select('id', { count: 'exact', head: true })
      .in('restaurant_id', scopeRestaurantIds).not('brand_override', 'is', null);

    const rfmAtRiskCount = await getRFMAtRiskCount(scopeRestaurantIds);

    res.json({
      success:     true,
      scope:       requested_scope,
      role,
      report_date: reportDate,
      summary: {
        total_revenue:      parseFloat(totalRevenue.toFixed(2)),
        top_branch_name:    topBranchName,
        top_branch_revenue: parseFloat(topBranchRev.toFixed(2)),
        top_item:           topItem,
        rfm_at_risk_count:  rfmAtRiskCount,
        menu_overrides:     overrideCount ?? 0,
      },
      revenue_matrix: revenueByStore,
    });
  } catch (err) {
    console.error('[enterprise-dashboard]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
