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
      service_type:    prev.service_type ?? 'dine_in',
      display_token:   tokenId,
      token_number:    tokenId,
      party_size:      partySize ?? prev.party_size,
      table_number:    Number.isFinite(primaryTable) ? primaryTable : prev.table_number ?? null,
      assigned_tables: tableNumbers,
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

module.exports = { syncConversationForTokenApproval, canonicalPhone, phoneVariants };
