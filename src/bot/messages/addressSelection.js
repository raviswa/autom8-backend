'use strict';

const { supabaseAdmin } = require('../../config/supabase');
const { sendWhatsAppInteractive, sendWhatsAppMessage } = require('../../helpers/whatsapp');
const { updateSessionContext } = require('../session/sessionStore');

function truncate(str, max) {
  const text = String(str || '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function sendTypeOwnAddressPrompt(session) {
  await updateSessionContext(session, {
    pending_address_candidates: null,
    awaiting_custom_address: true,
  });

  await sendWhatsAppMessage(
    session.phone,
    'Please type your full delivery address (house no., street, area, city, pincode).',
    session.restaurant_id,
  );

  return true;
}

async function sendAddressSelectionMessage(session, candidates, outletMatch) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return sendTypeOwnAddressPrompt(session);
  }

  const rows = candidates.map((candidate, index) => ({
    id: `addr_${index}`,
    title: truncate(candidate.short_label || candidate.formatted_address, 24),
    description: truncate(candidate.formatted_address, 72),
  }));

  rows.push({
    id: 'addr_custom',
    title: 'Type my own address',
    description: 'Enter your delivery address manually',
  });

  await updateSessionContext(session, {
    pending_address_candidates: candidates,
    awaiting_custom_address: false,
    outlet_id: outletMatch?.outlet?.id || session.context?.outlet_id || null,
  });

  return sendWhatsAppInteractive(
    session.phone,
    {
      type: 'list',
      header: { type: 'text', text: 'Confirm your delivery address' },
      body: {
        text: 'We found these addresses near your location. Select the one that best matches your delivery address, or type your own:',
      },
      action: {
        button: 'Choose Address',
        sections: [{ title: 'Nearby addresses', rows }],
      },
    },
    session.restaurant_id,
  );
}

async function sendNoDeliveryMessage(session) {
  const { data: outlets, error } = await supabaseAdmin
    .from('outlets')
    .select('name')
    .eq('restaurant_id', session.restaurant_id)
    .eq('is_active', true);

  if (error) {
    console.warn('[addressSelection] failed to fetch outlet list:', error.message);
  }

  const areaList = Array.isArray(outlets) && outlets.length > 0
    ? outlets.map((o) => o.name).filter(Boolean).join(', ')
    : 'our outlets';

  return sendWhatsAppInteractive(
    session.phone,
    {
      type: 'button',
      body: {
        text:
          `Sorry, we don't deliver to your area yet.\n\n` +
          `Our current outlets: ${areaList}.\n\n` +
          `Would you like to place a Takeaway order instead?`,
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'takeaway_yes', title: 'Yes, Takeaway' } },
          { type: 'reply', reply: { id: 'takeaway_no', title: 'No, thanks' } },
        ],
      },
    },
    session.restaurant_id,
  );
}

module.exports = {
  sendAddressSelectionMessage,
  sendNoDeliveryMessage,
  sendTypeOwnAddressPrompt,
  truncate,
};
