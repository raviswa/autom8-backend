'use strict';

/**
 * Shared helpers for forwarding inbound WhatsApp messages into the supply chat agent.
 * Used by dedicated supply webhook and dual-LOB restaurant webhook.
 */

const SUPPLY_CHAT_URL = (
  process.env.SUPPLY_CHAT_SERVICE_URL
  || process.env.CHAT_SERVICE_URL
  || 'http://localhost:8001'
).replace(/\/$/, '');

async function forwardToSupplyChatService(message, metadata, value, supplierId, clientId) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          ...value,
          messages: [message],
          metadata,
          _supply_context: {
            supplier_id: supplierId,
            client_id: clientId,
          },
        },
      }],
    }],
  };

  const response = await fetch(`${SUPPLY_CHAT_URL}/webhook/supply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`[supplyForward] Supply chat returned ${response.status}: ${body.slice(0, 200)}`);
    return false;
  }
  console.log(`[supplyForward] ✅ Forwarded ${message.type} from ${message.from} → supplier ${supplierId}`);
  return true;
}

module.exports = {
  SUPPLY_CHAT_URL,
  forwardToSupplyChatService,
};
