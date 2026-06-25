// Broadcast operational WhatsApp alerts to manager_phone + active manager/owner employees.

'use strict';

const { getOperationalAlertPhones } = require('./restaurantConfig');
const { sendWhatsAppMessage, sendWhatsAppInteractive } = require('./whatsapp');

/**
 * Send the same operational alert to all configured manager recipients.
 * Interactive buttons (approve/reject) go to the primary number only; others get plain text.
 */
async function sendOperationalAlerts(restaurantId, textMessage, options = {}) {
  const phones = await getOperationalAlertPhones(restaurantId);
  if (!phones.length) return { sent: 0, phones: [] };

  const { interactive = null } = options;
  let sent = 0;

  const sendText = async (phone) => {
    await sendWhatsAppMessage(phone, textMessage, restaurantId);
    sent += 1;
  };

  if (interactive) {
    const primary = phones[0];
    try {
      const ok = await sendWhatsAppInteractive(primary, interactive, restaurantId);
      if (!ok) await sendText(primary);
      else sent += 1;
    } catch (e) {
      console.warn(`[operational-alerts] interactive failed for ${primary}:`, e.message);
      try { await sendText(primary); } catch (_) { /* logged below */ }
    }
    for (const phone of phones.slice(1)) {
      try { await sendText(phone); } catch (e) {
        console.warn(`[operational-alerts] failed ${phone}:`, e.message);
      }
    }
  } else {
    for (const phone of phones) {
      try { await sendText(phone); } catch (e) {
        console.warn(`[operational-alerts] failed ${phone}:`, e.message);
      }
    }
  }

  return { sent, phones };
}

module.exports = { sendOperationalAlerts, getOperationalAlertPhones };
