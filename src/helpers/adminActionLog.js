'use strict';

const { supabaseAdmin } = require('../config/supabase');

async function logAdminAction({
  actorRole,
  actorLabel = null,
  actionType,
  tenantId = null,
  reason = null,
  meta = {},
}) {
  try {
    const { error } = await supabaseAdmin.from('admin_action_log').insert({
      actor_role: actorRole,
      actor_label: actorLabel,
      action_type: actionType,
      tenant_id: tenantId,
      reason: reason || null,
      meta: meta || {},
      occurred_at: new Date().toISOString(),
    });
    if (error) {
      console.warn('[admin_action_log] insert failed:', error.message);
    }
  } catch (err) {
    console.warn('[admin_action_log]', err.message);
  }
}

module.exports = { logAdminAction };
