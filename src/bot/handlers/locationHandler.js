'use strict';

const { reverseGeocode } = require('../../services/geocoding');
const { findNearestOutlet } = require('../../services/outletMatching');
const { updateSessionContext } = require('../session/sessionStore');
const {
  sendAddressSelectionMessage,
  sendNoDeliveryMessage,
} = require('../messages/addressSelection');

async function handleLocationMessage(message, session) {
  const latitude = Number(message?.location?.latitude);
  const longitude = Number(message?.location?.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return false;
  }

  await updateSessionContext(session, {
    delivery_lat: latitude,
    delivery_lng: longitude,
    awaiting_custom_address: false,
  });

  const candidates = await reverseGeocode(latitude, longitude);
  const outletMatch = await findNearestOutlet(session.restaurant_id, latitude, longitude);

  if (!outletMatch) {
    await updateSessionContext(session, {
      outlet_id: null,
      pending_address_candidates: null,
      awaiting_custom_address: false,
    });
    await sendNoDeliveryMessage(session);
    return true;
  }

  await updateSessionContext(session, {
    outlet_id: outletMatch.outlet.id,
  });

  await sendAddressSelectionMessage(session, candidates, outletMatch);
  return true;
}

module.exports = {
  handleLocationMessage,
};
