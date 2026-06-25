// src/routes/staff.js
// ============================================================================
// Employee (Staff) Management
//
// Owner  — full access, all roles
// Manager — can manage roles below manager: kitchen_staff, captain, waiter, marketing
//
// Endpoints:
//   GET    /api/staff              — list employees for this restaurant
//   POST   /api/staff              — onboard new employee
//   PUT    /api/staff/:id          — update details (name, phone, role)
//   PUT    /api/staff/:id/terminate — mark as terminated, revoke login
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');
const {
  NOTIFY_ROLES,
  validateAndNormalizeWhatsApp,
  roleRequiresWhatsApp,
  phoneDigitsMatch,
} = require('../helpers/phoneFormat');
const { writeAuditLog } = require('../helpers/auditLog');
const { requestPasswordReset } = require('../helpers/passwordReset');
const { invalidateRestaurantConfigCache } = require('../helpers/restaurantConfig');

// Roles a manager is allowed to manage (cannot touch own level or above)
const MANAGER_CAN_MANAGE = ['kitchen_staff', 'captain', 'waiter', 'marketing'];
const ALL_ROLES           = ['owner', 'manager', 'kitchen_staff', 'captain', 'waiter', 'marketing'];

// Notification roles — default whatsapp_number collection is relevant for these
// (canonical list lives in helpers/phoneFormat.js)

// ── GET /api/staff ────────────────────────────────────────────────────────────
// Returns active + terminated employees for this restaurant.
// Manager only sees roles they can manage.

router.get('/', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const isOwner   = ['owner', 'brand_owner', 'brand_manager'].includes(req.user_role);
    const isManager = req.user_role === 'manager';
    if (!isOwner && !isManager)
      return res.status(403).json({ error: 'Unauthorized' });

    let query = supabaseAdmin
      .from('employees')
      .select('id, full_name, email, phone, whatsapp_number, role, is_active, hired_at, terminated_at, termination_note, last_login, created_at')
      .eq('restaurant_id', req.restaurant_id)
      .order('hired_at', { ascending: false });

    // Managers only see the roles they're allowed to manage
    if (isManager) {
      query = query.in('role', MANAGER_CAN_MANAGE);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, employees: data ?? [] });
  } catch (err) {
    console.error('[staff/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── POST /api/staff ───────────────────────────────────────────────────────────
// Onboard a new employee.
// Creates a Supabase Auth user + employees row.
// Sends a WhatsApp invite if whatsapp_number is provided.

router.post('/', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const isOwner   = ['owner', 'brand_owner', 'brand_manager'].includes(req.user_role);
    const isManager = req.user_role === 'manager';
    if (!isOwner && !isManager)
      return res.status(403).json({ error: 'Unauthorized' });

    const { full_name, email, phone, whatsapp_number, role } = req.body;

    if (!full_name?.trim()) return res.status(400).json({ error: 'full_name is required' });
    if (!email?.trim())     return res.status(400).json({ error: 'email is required'     });
    if (!role)              return res.status(400).json({ error: 'role is required'      });

    // Role boundary check
    if (!ALL_ROLES.includes(role))
      return res.status(400).json({ error: `Invalid role. Must be one of: ${ALL_ROLES.join(', ')}` });

    if (isManager && !MANAGER_CAN_MANAGE.includes(role))
      return res.status(403).json({ error: `Managers cannot create a ${role} account` });

    const waRequired = roleRequiresWhatsApp(role);
    const waResult = validateAndNormalizeWhatsApp(whatsapp_number, { required: waRequired });
    if (waResult.error) return res.status(400).json({ error: waResult.error });
    const normalizedWhatsApp = waResult.value;

    // ── Create Supabase Auth user with a temporary password ─────────────────
    // Employee will reset on first login (send them a magic link or temp pw)
    const tempPassword = Math.random().toString(36).slice(-10) + 'Mm1!';

    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email:          email.trim().toLowerCase(),
      password:       tempPassword,
      email_confirm:  true,   // skip email confirmation for staff
    });

    if (authErr) {
      if (authErr.message?.includes('already')) {
        return res.status(409).json({ error: 'An employee with this email already exists.' });
      }
      throw authErr;
    }

    // ── Create employees row ─────────────────────────────────────────────────
    const { data: employee, error: empErr } = await supabaseAdmin
      .from('employees')
      .insert({
        id:              authData.user.id,
        restaurant_id:   req.restaurant_id,
        email:           email.trim().toLowerCase(),
        full_name:       full_name.trim(),
        phone:           phone           || null,
        whatsapp_number: normalizedWhatsApp,
        role,
        is_active:       true,
        hired_at:        new Date().toISOString(),
      })
      .select()
      .single();

    if (empErr) {
      // Roll back Auth user if employees insert fails
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id).catch(() => {});
      throw empErr;
    }

    // ── Send password reset email (employee sets own password) ───────────────
    await requestPasswordReset({
      email:        email.trim().toLowerCase(),
      employeeName: full_name,
      restaurantId: req.restaurant_id,
      triggeredBy:  'onboarding',
    }).catch(e => console.warn('[staff/create] password reset failed (non-fatal):', e.message));

    // ── Send WhatsApp welcome message if number provided ─────────────────────
    if (whatsapp_number && process.env.WHATSAPP_ACCESS_TOKEN) {
      const { sendWhatsAppMessageInternal } = require('../whatsapp');
      const loginUrl = process.env.FRONTEND_URL || 'https://app.autom8.works';
      sendWhatsAppMessageInternal(
        normalizedWhatsApp,
        `👋 Hi ${full_name.split(' ')[0]}!\n\n` +
        `You've been added to *Munafe* as *${role.replace('_', ' ')}*.\n\n` +
        `🔗 Set your password and log in here:\n${loginUrl}/login\n\n` +
        `📧 Your login email: ${email}\n\n` +
        `If you have any questions, contact your manager.`,
        req.restaurant_id,
      ).catch(e => console.warn('[staff/create] WA invite failed (non-fatal):', e.message));
    }

    // ── Audit log ────────────────────────────────────────────────────────────
    await writeAuditLog({
      user_id:       req.user.sub,
      restaurant_id: req.restaurant_id,
      action:        'Employee onboarded',
      details:       { employee_id: employee.id, full_name, role, email },
    });

    console.log(`[staff] ✅ Onboarded: ${full_name} (${role}) — ${email}`);

    res.status(201).json({
      success:  true,
      employee: {
        id:       employee.id,
        full_name: employee.full_name,
        email:    employee.email,
        role:     employee.role,
        hired_at: employee.hired_at,
      },
      message: normalizedWhatsApp
        ? 'Employee created. Login link sent via WhatsApp.'
        : 'Employee created. Ask them to use the login link.',
    });

  } catch (err) {
    console.error('[staff/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── PUT /api/staff/:id ────────────────────────────────────────────────────────
// Update employee details (name, phone, whatsapp_number, role).
// Cannot escalate role beyond what the current user is allowed to assign.

router.put('/:id', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const isOwner   = ['owner', 'brand_owner', 'brand_manager'].includes(req.user_role);
    const isManager = req.user_role === 'manager';
    if (!isOwner && !isManager)
      return res.status(403).json({ error: 'Unauthorized' });

    // Fetch target employee
    const { data: target } = await supabaseAdmin
      .from('employees')
      .select('id, role, is_active, whatsapp_number')
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id)
      .single();

    if (!target) return res.status(404).json({ error: 'Employee not found' });

    // Manager cannot edit owner/manager roles
    if (isManager && !MANAGER_CAN_MANAGE.includes(target.role))
      return res.status(403).json({ error: 'You cannot edit this employee' });

    const { full_name, phone, whatsapp_number, role } = req.body;
    const effectiveRole = role || target.role;
    const updates = { updated_at: new Date().toISOString() };

    if (full_name)       updates.full_name       = full_name.trim();
    if (phone !== undefined) updates.phone        = phone || null;

    if (whatsapp_number !== undefined || role) {
      const rawWa = whatsapp_number !== undefined
        ? whatsapp_number
        : target.whatsapp_number;

      const waResult = validateAndNormalizeWhatsApp(rawWa, {
        required: roleRequiresWhatsApp(effectiveRole),
      });
      if (waResult.error) return res.status(400).json({ error: waResult.error });
      updates.whatsapp_number = waResult.value;
    }

    if (role) {
      if (!ALL_ROLES.includes(role))
        return res.status(400).json({ error: `Invalid role` });
      if (isManager && !MANAGER_CAN_MANAGE.includes(role))
        return res.status(403).json({ error: `Managers cannot assign ${role} role` });
      updates.role = role;
    }

    const { data, error } = await supabaseAdmin
      .from('employees')
      .update(updates)
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id)
      .select()
      .single();

    if (error) throw error;

    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: 'Employee updated', details: { employee_id: req.params.id, changes: updates },
    });

    res.json({ success: true, employee: data });
  } catch (err) {
    console.error('[staff/update]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── POST /api/staff/:id/send-password-reset ─────────────────────────────────
// Owner/manager can trigger a password reset email for an active employee.

router.post('/:id/send-password-reset', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const isOwner   = ['owner', 'brand_owner', 'brand_manager'].includes(req.user_role);
    const isManager = req.user_role === 'manager';
    if (!isOwner && !isManager) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { data: target } = await supabaseAdmin
      .from('employees')
      .select('id, full_name, email, role, is_active, restaurant_id')
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id)
      .single();

    if (!target) return res.status(404).json({ error: 'Employee not found' });
    if (!target.is_active) {
      return res.status(400).json({ error: 'Cannot reset password for a terminated employee' });
    }

    if (isManager && !MANAGER_CAN_MANAGE.includes(target.role)) {
      return res.status(403).json({ error: 'You cannot reset this employee\'s password' });
    }

    const result = await requestPasswordReset({
      email:        target.email,
      employeeName: target.full_name,
      restaurantId: target.restaurant_id || req.restaurant_id,
      triggeredBy:  'manager',
    });

    await writeAuditLog({
      user_id: req.user.sub,
      restaurant_id: req.restaurant_id,
      action: 'Password reset sent',
      details: {
        employee_id: target.id,
        email: target.email,
        employee_notified: result.employeeNotified,
        manager_notified:  result.managersNotified?.sent ?? false,
      },
    });

    const msg = result.employeeNotified
      ? `Password reset email sent to ${target.email}`
      : result.managersNotified?.sent
        ? `Staff email failed — reset link sent to manager/owner inbox`
        : `Password reset queued for ${target.email}`;

    res.json({ success: true, message: msg, ...result });
  } catch (err) {
    console.error('[staff/send-password-reset]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── PUT /api/staff/:id/terminate ──────────────────────────────────────────────
// Terminate an employee (resignation, dismissal).
// Sets is_active = false, records terminated_at + note.
// Revokes all active Supabase sessions immediately.

router.put('/:id/terminate', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const isOwner   = ['owner', 'brand_owner', 'brand_manager'].includes(req.user_role);
    const isManager = req.user_role === 'manager';
    if (!isOwner && !isManager)
      return res.status(403).json({ error: 'Unauthorized' });

    const { termination_note = 'Resigned' } = req.body;

    // Fetch target
    const { data: target } = await supabaseAdmin
      .from('employees')
      .select('id, full_name, role, is_active, whatsapp_number')
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurant_id)
      .single();

    if (!target) return res.status(404).json({ error: 'Employee not found' });
    if (!target.is_active)
      return res.status(400).json({ error: 'Employee is already terminated' });

    // Managers cannot terminate owner or other managers
    if (isManager && !MANAGER_CAN_MANAGE.includes(target.role))
      return res.status(403).json({ error: `You cannot terminate a ${target.role}` });

    // Prevent self-termination
    if (req.params.id === req.user.sub)
      return res.status(400).json({ error: 'You cannot terminate your own account' });

    const { data: restaurant } = await supabaseAdmin
      .from('restaurants')
      .select('manager_phone')
      .eq('id', req.restaurant_id)
      .maybeSingle();

    let managerPhoneCleared = false;
    const empWa = target.whatsapp_number || target.phone || '';
    if (restaurant?.manager_phone && phoneDigitsMatch(empWa, restaurant.manager_phone)) {
      await supabaseAdmin
        .from('restaurants')
        .update({ manager_phone: null, updated_at: new Date().toISOString() })
        .eq('id', req.restaurant_id);
      invalidateRestaurantConfigCache(req.restaurant_id);
      managerPhoneCleared = true;
      console.log(`[staff] Cleared manager_phone for ${req.restaurant_id} (terminated ${target.full_name})`);
    }

    if (target.role === 'captain') {
      const { data: openTokens } = await supabaseAdmin
        .from('walk_in_tokens')
        .select('id, meta')
        .eq('restaurant_id', req.restaurant_id)
        .in('status', ['takeaway', 'waiting', 'pending_approval']);

      for (const row of openTokens ?? []) {
        if (row.meta?.captain_id !== target.id) continue;
        const meta = { ...(row.meta || {}) };
        delete meta.captain_id;
        delete meta.captain_name;
        delete meta.captain_assigned_at;
        await supabaseAdmin.from('walk_in_tokens').update({ meta }).eq('id', row.id);
      }
    }

    // ── Deactivate in employees table ────────────────────────────────────────
    const { error: updateErr } = await supabaseAdmin
      .from('employees')
      .update({
        is_active:        false,
        terminated_at:    new Date().toISOString(),
        termination_note: termination_note.trim(),
        updated_at:       new Date().toISOString(),
      })
      .eq('id', req.params.id);

    if (updateErr) throw updateErr;

    // ── Revoke all Supabase Auth sessions ────────────────────────────────────
    // This immediately prevents the employee from using any active login.
    await supabaseAdmin.auth.admin
      .deleteUser(req.params.id)
      .catch(e => console.warn('[staff/terminate] Auth delete failed (non-fatal):', e.message));

    // ── Optional: WA goodbye notification ────────────────────────────────────
    if (target.whatsapp_number && process.env.WHATSAPP_ACCESS_TOKEN) {
      const { sendWhatsAppMessageInternal } = require('../whatsapp');
      sendWhatsAppMessageInternal(
        target.whatsapp_number,
        `Hi ${target.full_name.split(' ')[0]}, your Munafe access has been deactivated. ` +
        `Thank you for your service. 🙏`,
        req.restaurant_id,
      ).catch(() => {});
    }

    // ── Audit log ────────────────────────────────────────────────────────────
    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      action: 'Employee terminated',
      details: {
        employee_id:    req.params.id,
        full_name:      target.full_name,
        role:           target.role,
        termination_note,
      },
    });

    console.log(`[staff] 🔒 Terminated: ${target.full_name} (${target.role})`);

    res.json({
      success: true,
      message: `${target.full_name}'s access has been revoked.`,
      manager_phone_cleared: managerPhoneCleared,
      requires_manager_phone_update: managerPhoneCleared,
    });

  } catch (err) {
    console.error('[staff/terminate]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── GET /api/staff/roles ──────────────────────────────────────────────────────
// Returns the roles the current user is allowed to assign.
// Used by the frontend to populate the role dropdown.

router.get('/roles', authenticateToken, getRestaurantId, async (req, res) => {
  const isOwner   = req.user_role === 'owner';
  const isManager = req.user_role === 'manager';

  if (!isOwner && !isManager)
    return res.status(403).json({ error: 'Unauthorized' });

  const roles = isOwner ? ALL_ROLES : MANAGER_CAN_MANAGE;

  const ROLE_META = {
    owner:         { label: 'Owner',         description: 'Full access to all features and settings'     },
    manager:       { label: 'Manager',        description: 'Token management, KDS, reports, marketing'   },
    kitchen_staff: { label: 'Kitchen Staff',  description: 'KDS only — orders appear on kitchen display'  },
    captain:       { label: 'Captain',        description: 'Takeaway fulfillment — WhatsApp pickup alerts' },
    waiter:        { label: 'Waiter',         description: 'Table service via kitchen display (no WhatsApp ops alerts)' },
    marketing:     { label: 'Marketing',      description: 'Campaigns, broadcast messages, analytics'    },
  };

  res.json({
    success: true,
    roles:   roles.map(r => ({ value: r, ...ROLE_META[r] })),
    notify_roles: NOTIFY_ROLES,
  });
});


module.exports = router;
