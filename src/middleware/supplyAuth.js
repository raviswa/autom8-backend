// src/middleware/supplyAuth.js
// ============================================================================
// Munafe Supply — Supplier context middleware
//
// getSupplierContext:
//   Must run AFTER authenticateToken (which populates req.user from the
//   Supabase JWT). Looks up the suppliers row for req.user.sub and attaches:
//     req.supplier    — full supplier profile row
//     req.supplier_id — suppliers.id (UUID, not auth user id)
//
// NOTE: authenticateToken sets req.user = { sub: user.id, email }
//       Always use req.user.sub (NOT req.user.id) to get the Supabase auth UUID.
//
// Usage (in supply route handlers):
//   router.get('/me', authenticateToken, getSupplierContext, handler)
// ============================================================================

'use strict';

const { supabaseAdmin } = require('../config/supabase');

async function getSupplierContext(req, res, next) {
  try {
    // FIX: authenticateToken sets req.user = { sub, email } — use .sub not .id
    const authUserId = req.user?.sub;

    if (!authUserId) {
      return res.status(401).json({ error: 'Authenticated user not found on request' });
    }

    const { data: supplier, error } = await supabaseAdmin
      .from('suppliers')
      .select([
        'id', 'name', 'business_name', 'email', 'phone',
        'waba_phone', 'waba_phone_number_id',
        'gstin', 'address', 'city', 'state', 'pincode',
        'logo_url', 'ordering_open_time', 'ordering_cutoff_time',
        'always_open', 'timezone', 'is_active', 'lob_type',
      ].join(', '))
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    if (error) {
      console.error('[supplyAuth] DB error fetching supplier context:', error.message);
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

    req.supplier    = supplier;
    req.supplier_id = supplier.id;

    next();
  } catch (err) {
    console.error('[supplyAuth] Unexpected error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getSupplierContext,
  supplyAuthMiddleware:     getSupplierContext,
  authenticateSupplyToken:  getSupplierContext,
};
