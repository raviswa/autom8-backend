// src/helpers/conversationState.js
// Sync conversation_states when the manager portal changes token status.
// Keeps the Python chat agent session aligned with walk_in_tokens reality.

'use strict';

const { supabaseAdmin } = require('../config/supabase');

function phoneVariants(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return [];

  const variants = new Set([digits]);
  if (digits.length === 10) variants.add(`91${digits}`);
  if (digits.length > 10) variants.add(digits.slice(-10));
  if (digits.startsWith('91') && digits.length === 12) variants.add(digits.slice(2));
  return [...variants];
}

function canonicalPhone(phone) {
  const variants = phoneVariants(phone);
  if (!variants.length) return null;
  const digits = variants[0];
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

async function findConversationRow(restaurantId, phone) {
  for (const variant of phoneVariants(phone)) {
    const { data } = await supabaseAdmin
      .from('conversation_states')
      .select('id, context, customer_phone')
      .eq('restaurant_id', restaurantId)
      .eq('customer_phone', variant)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

/**
 * After manager approves / assigns tables, update the customer's WhatsApp
 * session so catalog orders can proceed without create_booking errors.
 */
async function syncConversationForTokenApproval({
  restaurantId,
  customerPhone,
  tokenId,
  tableNumbers = [],
  partySize,
  specialsNoteSent = false,
}) {
  const phone = canonicalPhone(customerPhone);
  if (!phone || !restaurantId) return;

  try {
    const primaryTable = tableNumbers.length
      ? parseInt(String(tableNumbers[0]), 10)
      : null;

    const existing = await findConversationRow(restaurantId, customerPhone);
    const prev = existing?.context ?? {};
    const storedPhone = existing?.customer_phone ?? phone;

    const context = {
      ...prev,
      booking_step:    'awaiting_order',
      service_type:    'dine_in',
      last_service_type: 'dine_in',
      display_token:   tokenId,
      token_number:    tokenId,
      party_size:      partySize ?? prev.party_size,
      table_number:    Number.isFinite(primaryTable) ? primaryTable : prev.table_number ?? null,
      assigned_tables: tableNumbers,
      cart:            {},
      assigned_captain: null,
      order_from_cart:  false,
      booking_mechanism_order_source: null,
      // Portal sends catalog on assign — avoid duplicate from chat poll path
      _catalog_sent_after_party: true,
      ...(specialsNoteSent ? { _specials_note_sent: true } : {}),
    };

    await supabaseAdmin.from('conversation_states').upsert({
      restaurant_id:  restaurantId,
      customer_phone: storedPhone,
      adk_session_id: `${restaurantId}:${storedPhone}`,
      current_state:  'booking',
      context,
      updated_at:     new Date().toISOString(),
    }, { onConflict: 'restaurant_id,customer_phone' });

    console.log(`[conversation-sync] ✅ ${phone} → awaiting_order (token ${tokenId})`);
  } catch (err) {
    console.warn('[conversation-sync] Failed (non-fatal):', err.message);
  }
}

/**
 * After manager approves a scheduled delivery, sync session so the chat agent
 * can send the payment link and push the order to KDS.
 */
async function syncConversationForScheduledDeliveryApproval({
  restaurantId,
  customerPhone,
  tokenId,
  meta = {},
}) {
  const phone = canonicalPhone(customerPhone);
  if (!phone || !restaurantId) return;

  try {
    const existing = await findConversationRow(restaurantId, customerPhone);
    const prev = existing?.context ?? {};
    const storedPhone = existing?.customer_phone ?? phone;

    const context = {
      ...prev,
      booking_step:                'awaiting_scheduled_delivery_payment',
      service_type:                'delivery',
      last_service_type:           'delivery',
      display_token:               tokenId,
      token_number:                tokenId,
      scheduled_delivery_approved: true,
      booking_id:                  meta.booking_id ?? prev.booking_id,
      scheduled_at:                meta.scheduled_at ?? prev.scheduled_at,
      delivery_address:            meta.delivery_address ?? prev.delivery_address,
      order_total:                 meta.total ?? prev.order_total,
      order_totals:                meta.totals ?? prev.order_totals,
      pending_order_text:          meta.order_text ?? prev.pending_order_text,
      pending_cart:                meta.cart ?? prev.pending_cart,
    };

    await supabaseAdmin.from('conversation_states').upsert({
      restaurant_id:  restaurantId,
      customer_phone: storedPhone,
      adk_session_id: `${restaurantId}:${storedPhone}`,
      current_state:  'booking',
      context,
      updated_at:     new Date().toISOString(),
    }, { onConflict: 'restaurant_id,customer_phone' });

    console.log(`[conversation-sync] ✅ ${phone} → awaiting_scheduled_delivery_payment (${tokenId})`);
  } catch (err) {
    console.warn('[conversation-sync] scheduled delivery sync failed (non-fatal):', err.message);
  }
}

/**
 * After feedback completes, clear prepay UX from the chat session so the
 * next "Hi" starts a fresh visit instead of resuming awaiting_prepay.
 */
async function syncConversationForFeedbackComplete({ restaurantId, customerPhone }) {
  const phone = canonicalPhone(customerPhone);
  if (!phone || !restaurantId) return;

  try {
    const existing = await findConversationRow(restaurantId, customerPhone);
    if (!existing?.context) return;

    const prev = existing.context;
    const cleaned = String(prev.order_confirmed_summary || '')
      .replace(/\s*—\s*awaiting payment\s*$/i, '')
      .trim();

    const context = { ...prev };
    delete context.payment_link;
    delete context.razorpay_payment_link_id;
    delete context.order_confirmed_summary;
    delete context.order_total;
    if (cleaned) {
      context.last_order_summary = cleaned;
    }
    context.booking_step = 'visit_complete';

    await supabaseAdmin
      .from('conversation_states')
      .update({
        context,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);

    console.log(`[conversation-sync] ✅ ${phone} → visit_complete (feedback done)`);
  } catch (err) {
    console.warn('[conversation-sync] feedback complete sync failed (non-fatal):', err.message);
  }
}

module.exports = {
  syncConversationForTokenApproval,
  syncConversationForScheduledDeliveryApproval,
  syncConversationForFeedbackComplete,
  canonicalPhone,
  phoneVariants,
};
