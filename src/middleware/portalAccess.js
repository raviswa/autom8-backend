// src/middleware/portalAccess.js
// Portal-scoped access checks with permanent legacyFallback for employees
// who have zero employee_portal_access rows (byte-compatible with today's role gates).
// Does not modify auth.js.

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { LEVEL_RANK } = require('../config/portalAccess');

async function resolvePortalAccess(req, portal) {
  // Owner / brand_owner always pass — never gated by employee_portal_access.
  if (['owner', 'brand_owner'].includes(req.user_role)) return 'owner';

  if (!req.user?.sub || !req.restaurant_id) return null;

  const { data, error } = await supabaseAdmin
    .from('employee_portal_access')
    .select('access_level, lob_type')
    .eq('employee_id', req.user.sub)
    .eq('restaurant_id', req.restaurant_id)
    .eq('portal', portal);

  if (error) throw error;
  if (!data?.length) return null; // no fine-grained rows — caller must fall back

  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('lob_type')
    .eq('id', req.restaurant_id)
    .maybeSingle();

  const scoped = data.find((r) => r.lob_type === tenant?.lob_type);
  const global = data.find((r) => r.lob_type == null);
  return (scoped || global)?.access_level ?? null;
}

/**
 * @param {string} portal
 * @param {string} minLevel
 * @param {(req: any) => boolean} [legacyFallback] Exact boolean expression used today.
 */
function requirePortalAccess(portal, minLevel, legacyFallback) {
  return async (req, res, next) => {
    try {
      const level = await resolvePortalAccess(req, portal);

      if (level === null) {
        // Preserve today's exact behavior via the caller-supplied legacy check.
        if (typeof legacyFallback === 'function') {
          const legacyOk = !!legacyFallback(req);
          console.log(
            `[portal-access:fallback] portal=${portal} employee=${req.user?.sub} legacy_result=${legacyOk}`,
          );
          return legacyOk
            ? next()
            : res.status(403).json({ error: 'Not authorized.' });
        }
        return next(); // no legacy check — do not newly restrict
      }

      const ok = (LEVEL_RANK[level] || 0) >= (LEVEL_RANK[minLevel] || 0);
      console.log(
        `[portal-access] portal=${portal} employee=${req.user?.sub} level=${level} required=${minLevel} result=${ok}`,
      );
      if (!ok) {
        return res.status(403).json({ error: 'Not authorized for this action.' });
      }
      return next();
    } catch (err) {
      console.error('[portal-access] error, falling back to legacy check:', err.message);
      if (typeof legacyFallback === 'function') {
        return legacyFallback(req)
          ? next()
          : res.status(403).json({ error: 'Not authorized.' });
      }
      return next();
    }
  };
}

module.exports = {
  requirePortalAccess,
  resolvePortalAccess,
  LEVEL_RANK,
};
