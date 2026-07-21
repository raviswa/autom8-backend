'use strict';

const crypto = require('crypto');

function makeGiftToken() {
  return crypto.randomBytes(8).toString('hex');
}

async function createGiftLink(supabaseAdmin, {
  restaurantId,
  bookingId = null,
  gifterPhone = null,
  recipientPhone = null,
  recipientName = null,
  giftMessage = null,
  recipientAddress = null,
  recipientPincode = null,
}) {
  const token = makeGiftToken();
  const { data, error } = await supabaseAdmin
    .from('gift_links')
    .insert({
      restaurant_id: restaurantId,
      token,
      booking_id: bookingId,
      gifter_phone: gifterPhone,
      recipient_phone: recipientPhone,
      recipient_name: recipientName,
      gift_message: giftMessage,
      recipient_address: recipientAddress,
      recipient_pincode: recipientPincode,
      status: 'pending',
    })
    .select('id, token, status, created_at')
    .single();
  if (error) throw error;
  return data;
}

async function getGiftByToken(supabaseAdmin, token) {
  const { data, error } = await supabaseAdmin
    .from('gift_links')
    .select('id, restaurant_id, token, booking_id, gifter_phone, recipient_phone, recipient_name, gift_message, recipient_address, recipient_pincode, status, created_at, redeemed_at')
    .eq('token', String(token || '').trim())
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function redeemGiftLink(supabaseAdmin, token, { recipientPhone = null } = {}) {
  const gift = await getGiftByToken(supabaseAdmin, token);
  if (!gift) throw new Error('Gift link not found');
  if (gift.status === 'redeemed') return gift;

  const patch = {
    status: 'redeemed',
    redeemed_at: new Date().toISOString(),
  };
  if (recipientPhone) patch.recipient_phone = recipientPhone;

  const { data, error } = await supabaseAdmin
    .from('gift_links')
    .update(patch)
    .eq('id', gift.id)
    .select('id, token, status, redeemed_at, recipient_phone, gift_message, restaurant_id')
    .single();
  if (error) throw error;
  return data;
}

module.exports = { createGiftLink, getGiftByToken, redeemGiftLink, makeGiftToken };
