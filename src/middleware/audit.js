// src/middleware/audit.js
// Non-blocking audit_log writer. Never fails the request.

'use strict';

const { supabaseAdmin } = require('../config/supabase');

async function resolveTenantLobType(restaurantId) {
  if (!restaurantId) return null;
  try {
    const { data } = await supabaseAdmin
      .from('tenants')
      .select('lob_type')
      .eq('id', restaurantId)
      .maybeSingle();
    return data?.lob_type ?? null;
  } catch (_e) {
    return null;
  }
}

/**
 * Attach after auth + restaurant context. Logs successful mutations only.
 * @param {string} action e.g. 'settings.update'
 * @param {string|((req: any) => string|null)} entityTypeOrFn
 */
function withAudit(action, entityTypeOrFn) {
  return async (req, res, next) => {
    res.on('finish', async () => {
      if (res.statusCode >= 400) return;
      try {
        const entityType = typeof entityTypeOrFn === 'function'
          ? entityTypeOrFn(req)
          : entityTypeOrFn;

        let lobType = req.tenant_lob_type ?? null;
        if (lobType == null && req.restaurant_id) {
          lobType = await resolveTenantLobType(req.restaurant_id);
        }

        await supabaseAdmin.from('audit_log').insert({
          restaurant_id: req.restaurant_id,
          lob_type: lobType,
          portal: req.audit_portal || 'unknown',
          action,
          entity_type: entityType ?? null,
          entity_id: req.audit_entity_id != null
            ? String(req.audit_entity_id)
            : (req.params?.id != null ? String(req.params.id) : null),
          actor_employee_id: req.user?.sub ?? null,
          actor_role: req.user_role ?? null,
          before: req.audit_before ?? null,
          after: req.body ?? null,
        });
      } catch (err) {
        console.error('[audit] write failed (non-blocking):', err.message);
      }
    });
    next();
  };
}

/** Sets audit portal/entity defaults for owner dashboard settings mutations. */
function auditOwnerDashboardContext(req, _res, next) {
  req.audit_portal = 'owner_dashboard';
  if (req.restaurant_id) req.audit_entity_id = req.restaurant_id;
  next();
}

module.exports = {
  withAudit,
  auditOwnerDashboardContext,
};
