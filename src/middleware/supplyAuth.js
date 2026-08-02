// ============================================================================
// Munafe Supply — Supplier context middleware
//
// getSupplierContext:
//   Must run AFTER authenticateToken (which populates req.user from the
//   Supabase JWT). Resolves the calling user to a supplier account and
//   attaches:
//     req.supplier      — full supplier profile row (the business)
//     req.supplier_id   — suppliers.id
//     req.staff         — the supply_staff row for this login (null on legacy)
//     req.staff_role    — owner | manager | warehouse | delivery | accounts
//
// Resolution order:
//   1. supply_staff.auth_user_id  — multi-staff login (preferred)
//   2. suppliers.auth_user_id     — legacy single-login (role='owner')
//
// supplyAuthMiddleware / authenticateSupplyToken:
//   Compose JWT validation + getSupplierContext (most supply routers use
//   only the alias — they need both steps).
// ============================================================================

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { authenticateToken } = require('./auth');
const {
  isSubscriptionSoftLocked,
  buildLapsedPayload,
  LAPSED_ERROR,
} = require('../helpers/subscriptionAccess');

const SUPPLIER_SELECT = [
  'id', 'name', 'business_name', 'email', 'phone',
  'waba_phone', 'waba_phone_number_id',
  'gstin', 'address', 'city', 'state', 'pincode',
  'logo_url', 'ordering_open_time', 'ordering_cutoff_time',
  'always_open', 'timezone', 'is_active', 'lob_type',
  'manager_money_access',
].join(', ');

async function attachSubscriptionSoftLock(req, supplierId) {
  try {
    const { data: sub } = await supabaseAdmin
      .from('supplier_subscriptions')
      .select('id, status, trial_ends_at, renews_at')
      .eq('supplier_id', supplierId)
      .maybeSingle();
    req.supplier_subscription = sub || null;
    req.subscription_lapsed = isSubscriptionSoftLocked(sub);
    if (req.subscription_lapsed) {
      req.subscription_lapsed_payload = buildLapsedPayload(sub || {});
    }
  } catch (subErr) {
    console.warn('[supplyAuth] subscription lookup failed (non-fatal):', subErr.message);
    req.supplier_subscription = null;
    req.subscription_lapsed = false;
  }
}

async function getSupplierContext(req, res, next) {
  try {
    const authUserId = req.user?.sub;

    if (!authUserId) {
      return res.status(401).json({ error: 'Authenticated user not found on request' });
    }

    // 1. Preferred path — multi-staff login
    const { data: staff, error: staffError } = await supabaseAdmin
      .from('supply_staff')
      .select(`
        id, supplier_id, name, email, phone, role, is_active,
        suppliers ( ${SUPPLIER_SELECT} )
      `)
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    if (staffError) {
      // Table may not exist yet during rollout — fall through to legacy
      const missing = /relation .* does not exist|Could not find the table/i.test(staffError.message || '');
      if (!missing) {
        console.error('[supplyAuth] DB error fetching staff context:', staffError.message);
        return res.status(500).json({ error: 'Failed to load supplier profile' });
      }
    }

    if (staff) {
      if (!staff.is_active) {
        return res.status(403).json({
          error: 'Your account has been deactivated. Contact your supplier admin.',
        });
      }
      if (!staff.suppliers?.is_active) {
        return res.status(403).json({ error: 'This supplier account has been deactivated. Contact support.' });
      }

      req.supplier = staff.suppliers;
      req.supplier_id = staff.supplier_id;
      req.staff = { id: staff.id, name: staff.name, email: staff.email, role: staff.role };
      req.staff_role = staff.role;
      await attachSubscriptionSoftLock(req, staff.supplier_id);
      return next();
    }

    // 2. Legacy path — suppliers.auth_user_id (pre-supply_staff accounts)
    const { data: supplier, error: supplierError } = await supabaseAdmin
      .from('suppliers')
      .select(SUPPLIER_SELECT)
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    if (supplierError) {
      console.error('[supplyAuth] DB error fetching supplier context:', supplierError.message);
      return res.status(500).json({ error: 'Failed to load supplier profile' });
    }

    if (!supplier) {
      return res.status(403).json({
        error: 'No supplier account found for this user. Contact support.',
      });
    }

    if (!supplier.is_active) {
      return res.status(403).json({
        error: 'Your supplier account has been deactivated. Contact support.',
      });
    }

    req.supplier = supplier;
    req.supplier_id = supplier.id;
    req.staff = null;
    req.staff_role = 'owner';

    await attachSubscriptionSoftLock(req, supplier.id);
    return next();
  } catch (err) {
    console.error('[supplyAuth] Unexpected error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * JWT + supplier context in one middleware (for routes that only mount the alias).
 */
function supplyAuthMiddleware(req, res, next) {
  authenticateToken(req, res, (err) => {
    if (err) return next(err);
    // authenticateToken already responded on failure; only continues on success
    if (res.headersSent) return;
    getSupplierContext(req, res, next);
  });
}

/**
 * Soft-lock write gate — 402 with machine-readable subscription_lapsed.
 */
function requireSubscriptionWrite(req, res, next) {
  if (!req.subscription_lapsed) return next();
  const body = req.subscription_lapsed_payload || {
    error: LAPSED_ERROR,
    message: 'Subscription expired. Please renew to continue.',
  };
  return res.status(402).json(body);
}

/**
 * Route-level role guard. Must run after getSupplierContext / supplyAuthMiddleware.
 * 'owner' always passes.
 */
function requireSupplyRole(...allowedRoles) {
  return (req, res, next) => {
    const role = req.staff_role;
    if (!role) {
      return res.status(403).json({ error: 'No role found on this session. Contact support.' });
    }
    if (role === 'owner' || allowedRoles.includes(role)) {
      return next();
    }
    return res.status(403).json({ error: 'You do not have permission to access this.' });
  };
}

/**
 * Money section guard (claims, invoices, statements, ledger).
 * Always: owner, accounts.
 * Manager: only when suppliers.manager_money_access is true (owner setting).
 */
function requireMoneyAccess(req, res, next) {
  const role = req.staff_role;
  if (!role) {
    return res.status(403).json({ error: 'No role found on this session. Contact support.' });
  }
  if (role === 'owner' || role === 'accounts') return next();
  if (role === 'manager' && req.supplier?.manager_money_access === true) return next();
  return res.status(403).json({ error: 'You do not have permission to access this.' });
}

module.exports = {
  getSupplierContext,
  requireSupplyRole,
  requireMoneyAccess,
  requireSubscriptionWrite,
  supplyAuthMiddleware,
  authenticateSupplyToken: supplyAuthMiddleware,
};
