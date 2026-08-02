// ============================================================================
// Munafe Supply — Staff management
//
// Lets a supplier owner add, list, update, and deactivate staff logins
// under their business (warehouse, delivery, accounts, manager, additional
// owners). Scoped to supplier_id.
//
// Register in server-supply.js:
//   app.use('/api/supply/staff', require('./src/routes/supply/staff'));
// ============================================================================

'use strict';

const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const { supabaseAdmin } = require('../../config/supabase');
const { authenticateToken } = require('../../middleware/auth');
const { getSupplierContext, requireSupplyRole } = require('../../middleware/supplyAuth');
const { sendPasswordResetEmail } = require('../../helpers/passwordReset');

const VALID_ROLES = ['owner', 'manager', 'warehouse', 'delivery', 'accounts'];

async function countActiveOwners(supplierId, { excludeStaffId = null } = {}) {
  let q = supabaseAdmin
    .from('supply_staff')
    .select('id', { count: 'exact', head: true })
    .eq('supplier_id', supplierId)
    .eq('role', 'owner')
    .eq('is_active', true);
  if (excludeStaffId) q = q.neq('id', excludeStaffId);
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

function resolveInviteRedirect(req) {
  const origin = (req.headers.origin || '').replace(/\/$/, '');
  if (origin) return `${origin}/supply/reset-password`;
  if (process.env.SUPPLY_PORTAL_URL) {
    return `${String(process.env.SUPPLY_PORTAL_URL).replace(/\/$/, '')}/supply/reset-password`;
  }
  if (process.env.FRONTEND_URL) {
    return `${String(process.env.FRONTEND_URL).replace(/\/$/, '')}/supply/reset-password`;
  }
  return 'https://supply.munafe.in/supply/reset-password';
}

// ── GET /api/supply/staff ─────────────────────────────────────────────────
router.get('/', authenticateToken, getSupplierContext, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('supply_staff')
      .select('id, name, email, phone, role, is_active, last_login, hired_at, terminated_at')
      .eq('supplier_id', req.supplier_id)
      .order('hired_at', { ascending: true });

    if (error) {
      console.error('[supply/staff] List failed:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true, staff: data || [] });
  } catch (err) {
    console.error('[supply/staff] Unexpected error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/supply/staff ────────────────────────────────────────────────
router.post('/', authenticateToken, getSupplierContext, requireSupplyRole('owner'), async (req, res) => {
  let authUserId = null;
  try {
    const { name, email, phone, role } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!email?.trim()) return res.status(400).json({ error: 'Email is required' });
    if (!role || !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const { data: existingStaff } = await supabaseAdmin
      .from('supply_staff')
      .select('id, is_active')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existingStaff) {
      if (!existingStaff.is_active) {
        return res.status(400).json({
          error: 'A deactivated staff account with this email exists. Reactivate or update that row instead of inviting again.',
        });
      }
      return res.status(400).json({ error: 'A staff account with this email already exists.' });
    }

    const tempPassword = crypto.randomBytes(24).toString('hex');
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: normalizedEmail,
      password: tempPassword,
      email_confirm: true,
    });

    if (authError) {
      console.error('[supply/staff] Auth user creation failed:', authError.message);
      return res.status(400).json({ error: authError.message });
    }

    authUserId = authData.user.id;

    const { data: staff, error: staffError } = await supabaseAdmin
      .from('supply_staff')
      .insert({
        supplier_id: req.supplier_id,
        auth_user_id: authUserId,
        name: name.trim(),
        email: normalizedEmail,
        phone: phone?.trim() || null,
        role,
      })
      .select('id, name, email, phone, role, is_active, last_login, hired_at, terminated_at')
      .single();

    if (staffError) {
      console.error('[supply/staff] Staff insert failed:', staffError.message);
      await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(rollbackErr =>
        console.error('[supply/staff] Auth rollback failed:', rollbackErr.message)
      );
      return res.status(500).json({ error: `Staff creation failed: ${staffError.message}` });
    }

    const redirectTo = resolveInviteRedirect(req);
    await sendPasswordResetEmail(normalizedEmail, redirectTo, { isOwner: true }).catch(linkErr =>
      console.error('[supply/staff] Invite email failed (non-fatal):', linkErr.message)
    );

    console.log(`[supply/staff] ✅ New staff: ${staff.name} (${staff.role}) under supplier ${req.supplier_id}`);
    res.status(201).json({ success: true, staff });
  } catch (err) {
    if (authUserId) {
      await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => {});
    }
    console.error('[supply/staff] Unexpected error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/supply/staff/:id ─────────────────────────────────────────────
router.put('/:id', authenticateToken, getSupplierContext, requireSupplyRole('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, role, is_active } = req.body;

    if (role !== undefined && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const { data: existing, error: loadErr } = await supabaseAdmin
      .from('supply_staff')
      .select('id, role, is_active')
      .eq('id', id)
      .eq('supplier_id', req.supplier_id)
      .maybeSingle();

    if (loadErr) {
      console.error('[supply/staff] Load failed:', loadErr.message);
      return res.status(500).json({ error: loadErr.message });
    }
    if (!existing) {
      return res.status(404).json({ error: 'Staff member not found under this account' });
    }

    const demotingOwner = existing.role === 'owner' && existing.is_active
      && (role !== undefined && role !== 'owner');
    const deactivatingOwner = existing.role === 'owner' && existing.is_active
      && is_active !== undefined && !is_active;

    if (demotingOwner || deactivatingOwner) {
      const remaining = await countActiveOwners(req.supplier_id, { excludeStaffId: id });
      // Legacy owner (no staff row) still exists via suppliers.auth_user_id —
      // but if this is the only staff owner row, block demote/deactivate.
      if (remaining < 1 && req.staff?.id === id) {
        return res.status(400).json({
          error: 'Cannot remove the last owner. Promote another owner first.',
        });
      }
      if (remaining < 1) {
        return res.status(400).json({
          error: 'Cannot remove the last staff owner. Promote another owner first.',
        });
      }
    }

    const updates = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name?.trim() || null;
    if (phone !== undefined) updates.phone = phone?.trim() || null;
    if (role !== undefined) updates.role = role;
    if (is_active !== undefined) {
      updates.is_active = Boolean(is_active);
      updates.terminated_at = is_active ? null : new Date().toISOString();
    }

    if (Object.keys(updates).length <= 1) {
      return res.status(400).json({ error: 'No fields provided to update' });
    }

    const { data, error } = await supabaseAdmin
      .from('supply_staff')
      .update(updates)
      .eq('id', id)
      .eq('supplier_id', req.supplier_id)
      .select('id, name, email, phone, role, is_active, last_login, hired_at, terminated_at')
      .single();

    if (error) {
      console.error('[supply/staff] Update failed:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true, staff: data });
  } catch (err) {
    console.error('[supply/staff] Unexpected error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/supply/staff/:id ──────────────────────────────────────────
// Soft-delete only (is_active = false).
router.delete('/:id', authenticateToken, getSupplierContext, requireSupplyRole('owner'), async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existing, error: loadErr } = await supabaseAdmin
      .from('supply_staff')
      .select('id, role, is_active')
      .eq('id', id)
      .eq('supplier_id', req.supplier_id)
      .maybeSingle();

    if (loadErr) {
      return res.status(500).json({ error: loadErr.message });
    }
    if (!existing) {
      return res.status(404).json({ error: 'Staff member not found under this account' });
    }

    if (existing.role === 'owner' && existing.is_active) {
      const remaining = await countActiveOwners(req.supplier_id, { excludeStaffId: id });
      if (remaining < 1) {
        return res.status(400).json({
          error: 'Cannot deactivate the last owner. Promote another owner first.',
        });
      }
    }

    const { data, error } = await supabaseAdmin
      .from('supply_staff')
      .update({
        is_active: false,
        terminated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('supplier_id', req.supplier_id)
      .select('id, name, email, phone, role, is_active, last_login, hired_at, terminated_at')
      .single();

    if (error) {
      console.error('[supply/staff] Deactivate failed:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true, staff: data });
  } catch (err) {
    console.error('[supply/staff] Unexpected error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
