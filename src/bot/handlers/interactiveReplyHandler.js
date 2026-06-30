'use strict';

const { supabaseAdmin } = require('../../config/supabase');
const { sendWhatsAppMessage } = require('../../helpers/whatsapp');
const { forwardGeocode } = require('../../services/geocoding');
const { findNearestOutlet, haversineKm } = require('../../services/outletMatching');
const { updateSessionContext, getSession } = require('../session/sessionStore');
const { sendNoDeliveryMessage, sendTypeOwnAddressPrompt } = require('../messages/addressSelection');

function extractReplyId(message) {
  if (message?.interactive?.type === 'list_reply') {
    return message?.interactive?.list_reply?.id || null;
  }
  if (message?.interactive?.type === 'button_reply') {
    return message?.interactive?.button_reply?.id || null;
  }
  return null;
}

async function handleAddressSelection(replyId, session) {
  if (replyId === 'addr_custom') {
    await sendTypeOwnAddressPrompt(session);
    return true;
  }

  const index = Number.parseInt(String(replyId || '').replace('addr_', ''), 10);
  const candidates = session.context?.pending_address_candidates;
  const selected = Number.isFinite(index) && Array.isArray(candidates)
    ? candidates[index]
    : null;

  if (!selected) {
    await sendWhatsAppMessage(
      session.phone,
      'Sorry, that selection expired. Please share your location again.',
      session.restaurant_id,
    );
    return true;
  }

  return confirmAddress(session, selected.formatted_address, {
    lat: selected.lat,
    lng: selected.lng,
  });
}

async function handleCustomAddressText(text, session) {
  if (!session.context?.awaiting_custom_address) return false;

  const clean = String(text || '').trim();
  if (clean.length < 8) {
    await sendWhatsAppMessage(
      session.phone,
      'That looks too short. Please type your full delivery address (house no., street, area, city, pincode).',
      session.restaurant_id,
    );
    return true;
  }

  return confirmAddress(session, clean, null, { fromCustomText: true });
}

async function confirmAddress(session, addressText, candidateCoords = null, opts = {}) {
  let deliveryLat = candidateCoords?.lat ?? session.context?.delivery_lat ?? null;
  let deliveryLng = candidateCoords?.lng ?? session.context?.delivery_lng ?? null;
  let outletMatch = null;

  if (opts.fromCustomText) {
    const geo = await forwardGeocode(addressText);
    if (geo?.lat && geo?.lng) {
      deliveryLat = geo.lat;
      deliveryLng = geo.lng;
      outletMatch = await findNearestOutlet(session.restaurant_id, deliveryLat, deliveryLng);

      if (!outletMatch) {
        await sendNoDeliveryMessage(session);
        await updateSessionContext(session, {
          awaiting_custom_address: true,
          pending_address_candidates: null,
        });
        return true;
      }
    }
  }

  let outletId = outletMatch?.outlet?.id || session.context?.outlet_id || null;

  if (!outletId && Number.isFinite(deliveryLat) && Number.isFinite(deliveryLng)) {
    outletMatch = await findNearestOutlet(session.restaurant_id, deliveryLat, deliveryLng);
    outletId = outletMatch?.outlet?.id || null;
  }

  if (!outletId) {
    await sendWhatsAppMessage(
      session.phone,
      'Please share your location again so we can match the nearest outlet.',
      session.restaurant_id,
    );
    return true;
  }

  const { data: outlet, error } = await supabaseAdmin
    .from('outlets')
    .select('id, name, lat, lng')
    .eq('id', outletId)
    .maybeSingle();

  if (error || !outlet) {
    await sendWhatsAppMessage(
      session.phone,
      'Sorry, we could not confirm your outlet right now. Please share your location again.',
      session.restaurant_id,
    );
    return true;
  }

  const distanceKm = (Number.isFinite(deliveryLat) && Number.isFinite(deliveryLng))
    ? haversineKm(deliveryLat, deliveryLng, Number(outlet.lat), Number(outlet.lng))
    : null;

  const latestSession = await getSession(session.restaurant_id, session.phone);
  await updateSessionContext(latestSession || session, {
    delivery_address: addressText,
    delivery_lat: Number.isFinite(deliveryLat) ? deliveryLat : null,
    delivery_lng: Number.isFinite(deliveryLng) ? deliveryLng : null,
    outlet_id: outlet.id,
    pending_address_candidates: null,
    awaiting_custom_address: false,
  });

  const distanceLabel = Number.isFinite(distanceKm)
    ? `${distanceKm.toFixed(1)} km away`
    : 'distance unavailable';

  await sendWhatsAppMessage(
    session.phone,
    `Address Details Confirmed\n\n` +
      `Outlet: ${outlet.name} (${distanceLabel})\n` +
      `Delivering to: ${addressText}`,
    session.restaurant_id,
  );

  return true;
}

async function handleInteractiveReply(message, session) {
  const replyId = extractReplyId(message);
  if (!replyId) return false;
  if (!replyId.startsWith('addr_')) return false;

  return handleAddressSelection(replyId, session);
}

module.exports = {
  handleInteractiveReply,
  handleCustomAddressText,
  handleAddressSelection,
  confirmAddress,
  extractReplyId,
};
