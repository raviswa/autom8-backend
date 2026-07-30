'use strict';

/**
 * My Account — self-service profile summary + voluntary account close.
 *
 * GET  /api/account          — logged-in user + outlet summary
 * POST /api/account/delete   — owner voluntarily closes outlet + frees WhatsApp number
 *
 * Soft-lock (unpaid) ≠ delete account:
 *   Soft-lock  — billing grace ended; ops paused; WhatsApp stays linked so they can renew.
 *   Delete     — owner chooses to leave; cancel plan, RELEASE WhatsApp so the number
 *                can be Embedded-Signup’d onto any other Autom8 account, then close outlet.
 *
 * Data retention: soft-close of tenant/users (is_active=false), no hard wipe of orders.
 */

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');
const { writeAuditLog } = require('../helpers/auditLog');
const { invalidateRestaurantConfigCache } = require('../helpers/restaurantConfig');
const { FEEDBACK_REASONS, clearOutreach } = require('../helpers/churnReminders');
const { recordActivationEvent } = require('../helpers/tenantActivation');
const { releaseWhatsAppBinding } = require('../helpers/releaseWhatsAppBinding');
const { requireStepUpInHandler } = require('../helpers/stepUpAuth');

router.get('/', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data: emp, error: empErr } = await supabaseAdmin
      .from('employees')
      .select('id, email, full_name, phone, role, restaurant_id, brand_id, is_active')
      .eq('id', req.user.sub)
      .maybeSingle();
    if (empErr) throw empErr;
    if (!emp) return res.status(404).json({ error: 'User not found' });

    let restaurant = null;
    if (req.restaurant_id) {
      const { data: tenant } = await supabaseAdmin
        .from('tenants')
        .select('id, name, display_name, contact_phone, contact_email, whatsapp_number, lob_type, is_active')
        .eq('id', req.restaurant_id)
        .maybeSingle();
      restaurant = tenant || null;
    }

    return res.json({
      ok: true,
      user: {
        id: emp.id,
        email: emp.email,
        full_name: emp.full_name,
        phone: emp.phone || null,
        role: emp.role,
        restaurant_id: emp.restaurant_id || req.restaurant_id || null,
        brand_id: emp.brand_id || null,
      },
      restaurant: restaurant
        ? {
            id: restaurant.id,
            name: restaurant.display_name || restaurant.name,
            display_name: restaurant.display_name || restaurant.name,
            legal_name: restaurant.name,
            contact_phone: restaurant.contact_phone || restaurant.whatsapp_number || null,
            contact_email: restaurant.contact_email || null,
            lob_type: restaurant.lob_type || null,
            is_active: restaurant.is_active !== false,
            whatsapp_number: restaurant.whatsapp_number || null,
          }
        : null,
      can_delete_account: emp.role === 'owner' && !!req.restaurant_id,
      exit_reasons: FEEDBACK_REASONS,
    });
  } catch (err) {
    console.error('[account/GET]', err.message);
    return res.status(500).json({ error: err.message || 'Failed to load account' });
  }
});

/**
 * Voluntary close. Owners only.
 * Body: { confirm_name, reason?, note? }
 */
router.post('/delete', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const role = req.user_role;
    if (role !== 'owner') {
      return res.status(403).json({
        error: role === 'brand_owner' || role === 'brand_manager'
          ? 'Brand accounts: deactivate outlets from Brand settings, or contact Autom8 support to close the brand.'
          : 'Only the outlet owner can delete this account.',
      });
    }

    const restaurantId = req.restaurant_id;
    if (!restaurantId) {
      return res.status(400).json({ error: 'No outlet linked to this account.' });
    }

    const confirmName = String(req.body?.confirm_name || '').trim();
    if (!confirmName) {
      return res.status(400).json({ error: 'Type your business name to confirm deletion.' });
    }

    const reasonRaw = String(req.body?.reason || '').trim().toLowerCase();
    const reason = FEEDBACK_REASONS.includes(reasonRaw) ? reasonRaw : 'other';
    const note = String(req.body?.note || '').trim().slice(0, 1000) || null;

    const { data: tenant, error: tenantErr } = await supabaseAdmin
      .from('tenants')
      .select('id, name, display_name, is_active, whatsapp_number, waba_id')
      .eq('id', restaurantId)
      .maybeSingle();
    if (tenantErr) throw tenantErr;
    if (!tenant) return res.status(404).json({ error: 'Outlet not found' });
    if (tenant.is_active === false) {
      return res.status(400).json({ error: 'This account is already closed.' });
    }

    const expected = String(tenant.display_name || tenant.name || '').trim().toLowerCase();
    if (!expected || confirmName.toLowerCase() !== expected) {
      return res.status(400).json({
        error: 'Business name does not match. Type the exact display name shown above.',
      });
    }

    try {
      await requireStepUpInHandler(req, 'delete_account');
    } catch (stepErr) {
      return res.status(stepErr.status || 403).json({
        error: stepErr.message || 'WhatsApp verification required before deleting the account.',
      });
    }

    const now = new Date().toISOString();
    const steps = {
      whatsapp_released: false,
      subscription_cancelled: false,
      tenant_closed: false,
      employees_deactivated: false,
      churn_outreach_cleared: false,
      exit_feedback_recorded: false,
    };

    // ── 1. Free WhatsApp number for re-link on another Autom8 account ────────
    // (Not the same as soft-lock, which keeps the WA binding while unpaid.)
    let waRelease = null;
    try {
      waRelease = await releaseWhatsAppBinding(restaurantId, {
        reason: 'voluntary_account_delete',
        actorId: req.user.sub,
      });
      steps.whatsapp_released = Boolean(waRelease?.released);
    } catch (err) {
      console.error('[account/delete] releaseWhatsAppBinding:', err.message);
      return res.status(500).json({
        error: 'Could not release WhatsApp binding. Account was not closed — try again or contact support.',
      });
    }

    // ── 2. Cancel Autom8 subscription (stop renewals) ───────────────────────
    const { data: sub } = await supabaseAdmin
      .from('tenant_subscriptions')
      .select('id, status')
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (sub?.id) {
      const { error: subErr } = await supabaseAdmin
        .from('tenant_subscriptions')
        .update({ status: 'cancelled', updated_at: now })
        .eq('id', sub.id);
      if (subErr) {
        console.warn('[account/delete] subscription cancel:', subErr.message);
      } else {
        steps.subscription_cancelled = true;
      }
    } else {
      steps.subscription_cancelled = true;
    }

    // ── 3. Close outlet (Autom8 account) — keep order history ───────────────
    const { error: tenantUpdErr } = await supabaseAdmin
      .from('tenants')
      .update({ is_active: false, updated_at: now })
      .eq('id', restaurantId);
    if (tenantUpdErr) throw tenantUpdErr;
    steps.tenant_closed = true;

    const { error: empErr } = await supabaseAdmin
      .from('employees')
      .update({ is_active: false })
      .eq('restaurant_id', restaurantId)
      .eq('is_active', true);
    if (empErr) {
      console.warn('[account/delete] employees:', empErr.message);
    } else {
      steps.employees_deactivated = true;
    }

    // ── 4. Stop miss-you emails (closed ≠ idle win-back) ─────────────────────
    try {
      await clearOutreach(restaurantId);
      steps.churn_outreach_cleared = true;
    } catch (err) {
      console.warn('[account/delete] clearOutreach:', err.message);
    }

    try {
      const feedbackNote = ['voluntary_delete', note].filter(Boolean).join(': ').slice(0, 1000);
      const { error: fbErr } = await supabaseAdmin.from('churn_feedback').insert({
        tenant_id: restaurantId,
        reason,
        note: feedbackNote,
        submitted_at: now,
      });
      if (fbErr) {
        console.warn('[account/delete] churn_feedback:', fbErr.message);
      } else {
        steps.exit_feedback_recorded = true;
      }
    } catch (err) {
      console.warn('[account/delete] churn_feedback:', err.message);
    }

    try {
      await recordActivationEvent(restaurantId, 'account_closed', {
        source: 'voluntary_delete',
        reason,
        by_user_id: req.user.sub,
        whatsapp_released: steps.whatsapp_released,
        freed_phone_number_ids: waRelease?.phone_number_ids || [],
      });
    } catch (_) { /* non-fatal */ }

    try {
      await writeAuditLog({
        user_id: req.user.sub,
        restaurant_id: restaurantId,
        action: 'account.delete',
        details: {
          confirm_name: confirmName,
          reason,
          note: note || null,
          previous_whatsapp_number: tenant.whatsapp_number || null,
          previous_waba_id: tenant.waba_id || null,
          steps,
          wa_release: waRelease?.steps || null,
        },
      });
    } catch (_) { /* non-fatal */ }

    try {
      invalidateRestaurantConfigCache(restaurantId);
    } catch (_) { /* non-fatal */ }

    return res.json({
      ok: true,
      message:
        'Account closed. Your WhatsApp number is released and can be linked to another Autom8 account. '
        + 'Subscription cancelled and team logins disabled. Order history is retained.',
      steps,
      whatsapp_released: steps.whatsapp_released,
      data_retention: 'outlet_closed_whatsapp_released',
    });
  } catch (err) {
    console.error('[account/delete]', err.message);
    return res.status(500).json({ error: err.message || 'Failed to delete account' });
  }
});

module.exports = router;
