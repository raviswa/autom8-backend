'use strict';

const { supabaseAdmin } = require('../../config/supabase');
const { canonicalPhone, phoneVariants } = require('../../helpers/conversationState');

async function getSession(restaurantId, phone) {
  if (!restaurantId || !phone) return null;

  for (const variant of phoneVariants(phone)) {
    const { data, error } = await supabaseAdmin
      .from('conversation_states')
      .select('id, restaurant_id, customer_phone, current_state, context')
      .eq('restaurant_id', restaurantId)
      .eq('customer_phone', variant)
      .maybeSingle();

    if (error) {
      console.warn('[sessionStore] getSession query failed:', error.message);
      return null;
    }

    if (data) {
      return {
        id: data.id,
        restaurant_id: data.restaurant_id,
        phone: data.customer_phone,
        current_state: data.current_state,
        context: data.context || {},
      };
    }
  }

  const canonical = canonicalPhone(phone);
  if (!canonical) return null;

  return {
    id: null,
    restaurant_id: restaurantId,
    phone: canonical,
    current_state: 'booking',
    context: {},
  };
}

async function updateSessionContext(session, patch) {
  if (!session?.restaurant_id || !session?.phone) {
    throw new Error('session.restaurant_id and session.phone are required');
  }

  const { data: latest, error: latestErr } = await supabaseAdmin
    .from('conversation_states')
    .select('context')
    .eq('restaurant_id', session.restaurant_id)
    .eq('customer_phone', session.phone)
    .maybeSingle();

  if (latestErr) {
    throw new Error(`[sessionStore] failed reading latest context: ${latestErr.message}`);
  }

  const baseContext = latest?.context || session.context || {};

  const nextContext = {
    ...baseContext,
    ...patch,
  };

  const payload = {
    restaurant_id: session.restaurant_id,
    customer_phone: session.phone,
    adk_session_id: `${session.restaurant_id}:${session.phone}`,
    current_state: 'booking',
    context: nextContext,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('conversation_states')
    .upsert(payload, { onConflict: 'restaurant_id,customer_phone', ignoreDuplicates: false })
    .select('id, restaurant_id, customer_phone, current_state, context')
    .single();

  if (error) {
    throw new Error(`[sessionStore] updateSessionContext failed: ${error.message}`);
  }

  return {
    id: data.id,
    restaurant_id: data.restaurant_id,
    phone: data.customer_phone,
    current_state: data.current_state,
    context: data.context || {},
  };
}

module.exports = {
  getSession,
  updateSessionContext,
};
