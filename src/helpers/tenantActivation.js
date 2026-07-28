'use strict';

/**
 * Onboarding / activation timeline events for Autom8 Works console.
 */

const { supabaseAdmin } = require('../config/supabase');

async function recordActivationEvent(tenantId, eventType, meta = {}) {
  if (!tenantId || !eventType) return { recorded: false, reason: 'missing_args' };
  try {
    const { data, error } = await supabaseAdmin
      .from('tenant_activation_events')
      .insert({
        tenant_id: tenantId,
        event_type: String(eventType),
        meta: meta || {},
        occurred_at: new Date().toISOString(),
      })
      .select('id, event_type, occurred_at')
      .maybeSingle();

    if (error) {
      // Unique first-of-type index — treat as already recorded
      if (error.code === '23505') {
        return { recorded: false, reason: 'already_exists' };
      }
      console.warn('[tenantActivation] insert failed:', error.message);
      return { recorded: false, reason: error.message };
    }
    return { recorded: true, event: data };
  } catch (err) {
    console.warn('[tenantActivation]', err.message);
    return { recorded: false, reason: err.message };
  }
}

async function listActivationEvents(tenantId) {
  const { data, error } = await supabaseAdmin
    .from('tenant_activation_events')
    .select('id, event_type, occurred_at, meta')
    .eq('tenant_id', tenantId)
    .order('occurred_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

module.exports = {
  recordActivationEvent,
  listActivationEvents,
};
