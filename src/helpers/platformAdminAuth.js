'use strict';

/**
 * Resolve Autom8 Works console role from internal secrets.
 *   AUTOM8_KDS_SECRET     → super_admin
 *   AUTOM8_SUPPORT_SECRET → support_readonly
 */

const {
  getKdsSecret,
  extractInternalSecret,
} = require('../config/internalSecret');

const ROLE_SUPER = 'super_admin';
const ROLE_SUPPORT = 'support_readonly';

function getSupportSecret() {
  const s = String(process.env.AUTOM8_SUPPORT_SECRET || '').trim();
  return s || null;
}

function resolveAdminRole(candidate) {
  if (!candidate) return null;
  try {
    if (candidate === getKdsSecret()) return ROLE_SUPER;
  } catch (_) { /* production may throw if unset — treat as no match */ }
  const support = getSupportSecret();
  if (support && candidate === support) return ROLE_SUPPORT;
  return null;
}

function requirePlatformAdmin(req, res, next) {
  const secret = extractInternalSecret(req);
  const role = resolveAdminRole(secret);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  req.adminRole = role;
  req.adminLabel = role === ROLE_SUPER ? 'autom8.admin' : 'autom8.support';
  return next();
}

function requireSuperAdmin(req, res, next) {
  if (req.adminRole === ROLE_SUPER) return next();
  return res.status(403).json({ error: 'super_admin role required' });
}

/** Actions allowed for support_readonly (everything else = super_admin only). */
const SUPPORT_ALLOWED_ACTIONS = new Set([
  'impersonate',
  'view_tenant',
  'cancel_churn_sequence', // read-adjacent ops support may clear sequences? plan says no billing/suspend — cancel churn is ok for support? Plan: "support_readonly (roster, timelines, impersonate; no suspend/billing/comp)". Cancel churn / trigger miss_you = super only.
]);

function requireAction(actionType) {
  return (req, res, next) => {
    if (req.adminRole === ROLE_SUPER) return next();
    if (req.adminRole === ROLE_SUPPORT && SUPPORT_ALLOWED_ACTIONS.has(actionType)) {
      return next();
    }
    return res.status(403).json({ error: `Action '${actionType}' requires super_admin` });
  };
}

module.exports = {
  ROLE_SUPER,
  ROLE_SUPPORT,
  getSupportSecret,
  resolveAdminRole,
  requirePlatformAdmin,
  requireSuperAdmin,
  requireAction,
  SUPPORT_ALLOWED_ACTIONS,
};
